use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    response::Response,
    Json,
};
use chrono::{DateTime, Duration, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::{jwt::validate_user_token, middleware::AuthUser},
    error::{AppError, Result},
    models::{device::Device, telemetry::TelemetryRecord},
    AppState,
};

pub async fn live_telemetry(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Value>> {
    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    let key = format!("telemetry:{device_id}");
    let mut redis_conn = state.redis.clone();
    let raw: Option<String> = redis::cmd("GET").arg(&key).query_async(&mut redis_conn).await?;

    match raw {
        None => Err(AppError::NotFound),
        Some(json_str) => {
            let mut val: Value = serde_json::from_str(&json_str)
                .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")))?;

            // Compute age_ms
            if let Some(ts) = val.get("ts").and_then(|t| t.as_i64()) {
                let then = DateTime::from_timestamp(ts, 0).unwrap_or_else(Utc::now);
                let age_ms = (Utc::now() - then).num_milliseconds().max(0);
                val["age_ms"] = age_ms.into();
            }

            Ok(Json(val))
        }
    }
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub resolution: Option<String>,
}

pub async fn telemetry_history(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>> {
    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    let to = query.to.unwrap_or_else(Utc::now);
    let from = query.from.unwrap_or_else(|| to - Duration::hours(1));

    // Enforce max range of 24 hours
    if (to - from) > Duration::hours(24) {
        return Err(AppError::Validation("max range is 24 hours".to_string()));
    }

    let records = TelemetryRecord::query_history(device_id, from, to, &state.db).await?;
    Ok(Json(json!({ "records": records, "from": from, "to": to })))
}

pub async fn telemetry_stream(
    ws_upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(device_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Response> {
    // Auth via query param token (WebSocket doesn't support headers easily)
    let token = params.get("token").ok_or(AppError::Unauthorized)?;
    let claims = validate_user_token(token, &state.config.auth.jwt_secret)?;

    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    Ok(ws_upgrade.on_upgrade(move |ws| stream_telemetry(ws, device_id, state)))
}

async fn stream_telemetry(ws: WebSocket, device_id: Uuid, state: AppState) {
    let (mut tx, mut rx) = ws.split();

    // Subscribe to telemetry updates via Redis keyspace or poll
    // For simplicity: poll Redis every 500ms and push if data changed
    let mut last_ts: Option<i64> = None;

    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                let key = format!("telemetry:{device_id}");
                let mut redis_conn = state.redis.clone();
                let raw: Option<String> = match redis::cmd("GET").arg(&key).query_async(&mut redis_conn).await {
                    Ok(v) => v,
                    Err(_) => break,
                };

                if let Some(json_str) = raw {
                    if let Ok(val) = serde_json::from_str::<Value>(&json_str) {
                        let ts = val.get("ts").and_then(|t| t.as_i64());
                        if ts != last_ts {
                            last_ts = ts;
                            let msg = json!({ "type": "telemetry", "data": val }).to_string();
                            if tx.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}
