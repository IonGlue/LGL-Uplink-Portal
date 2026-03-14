use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    auth::middleware::AuthUser,
    error::{AppError, Result},
    models::{
        audit::AuditLog,
        claim::ControlClaim,
        device::Device,
    },
    ws::commands::DeviceCommand,
    AppState,
};

async fn get_device_for_user(device_id: Uuid, org_id: Uuid, state: &AppState) -> Result<Device> {
    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if device.org_id != Some(org_id) {
        return Err(AppError::NotFound);
    }
    Ok(device)
}

pub async fn claim_control(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    get_device_for_user(device_id, claims.org_id, &state).await?;

    let claim = ControlClaim::claim(device_id, claims.sub, state.config.control.claim_ttl, &state.db).await?;

    let _ = AuditLog::log_user_command(&state.db, claims.sub, device_id, "claim.acquire", None).await;

    Ok(Json(serde_json::json!({
        "claimed": true,
        "expires_at": claim.expires_at,
    })))
}

pub async fn release_control(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    get_device_for_user(device_id, claims.org_id, &state).await?;

    // Admins can force-release any claim
    if claims.role == "admin" {
        ControlClaim::force_release(device_id, &state.db).await?;
    } else {
        ControlClaim::release(device_id, claims.sub, &state.db).await?;
    }

    let _ = AuditLog::log_user_command(&state.db, claims.sub, device_id, "claim.release", None).await;

    Ok(Json(serde_json::json!({ "released": true })))
}

pub async fn send_command(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>> {
    get_device_for_user(device_id, claims.org_id, &state).await?;

    // Validate claim (admins bypass)
    if claims.role != "admin" {
        ControlClaim::validate_active(device_id, claims.sub, &state.db).await?;
    }

    // Parse and validate the command
    let command: DeviceCommand = serde_json::from_value(body.clone())
        .map_err(|e| AppError::InvalidCommand(e.to_string()))?;
    command.validate()?;

    // Publish to Redis
    let channel = format!("commands:{device_id}");
    let wire_json = command.to_wire_json().to_string();

    let mut redis_conn = state.redis.clone();
    redis::cmd("PUBLISH")
        .arg(&channel)
        .arg(&wire_json)
        .query_async::<()>(&mut redis_conn)
        .await?;

    // Refresh claim expiry on successful command
    if claims.role != "admin" {
        let _ = ControlClaim::refresh_expiry(device_id, claims.sub, state.config.control.claim_ttl, &state.db).await;
    }

    // Audit log
    let _ = AuditLog::log_user_command(
        &state.db,
        claims.sub,
        device_id,
        "command.send",
        Some(body),
    )
    .await;

    Ok(Json(serde_json::json!({ "status": "sent" })))
}
