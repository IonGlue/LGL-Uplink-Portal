use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tokio::time::{interval, timeout};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    auth::jwt::generate_device_token,
    models::{
        audit::AuditLog,
        device::Device,
        telemetry::{TelemetryRecord, TelemetryReport},
    },
    AppState,
};

#[derive(Debug, Deserialize)]
struct RegisterMsg {
    msg_type: String,
    device_id: String,
    hardware_id: String,
    hostname: String,
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "msg_type", rename_all = "snake_case")]
enum DeviceMessage {
    Register(RegisterMsg),
    Telemetry(TelemetryReport),
    #[serde(other)]
    Unknown,
}

pub async fn handle_device_ws(ws: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);

    // Spawn a task to forward outbound messages to the WebSocket
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // 1. Wait for registration message (10s timeout)
    let first_msg = match timeout(Duration::from_secs(10), ws_rx.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => {
            warn!("device did not send registration in time");
            return;
        }
    };

    let register: RegisterMsg = match serde_json::from_str::<RegisterMsg>(&first_msg) {
        Ok(msg) if msg.msg_type == "register" => msg,
        _ => {
            warn!("device sent unexpected first message");
            return;
        }
    };

    info!(device_id = %register.device_id, "device registering");

    // 2. Register or update device in DB
    let (device, is_new_or_changed) = match Device::register_or_update(
        &register.device_id,
        &register.hardware_id,
        &register.hostname,
        &register.version,
        &state.db,
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            error!("failed to register device: {e}");
            return;
        }
    };

    // 3. Audit log
    let action = if is_new_or_changed { "device.register" } else { "device.reconnect" };
    let _ = AuditLog::log_device_event(
        &state.db,
        device.id,
        action,
        Some(json!({ "hostname": device.hostname, "version": device.version })),
    )
    .await;

    // 4. Generate JWT and send register_response
    let token = match generate_device_token(
        device.id,
        &device.device_id,
        &state.config.auth.jwt_secret,
        state.config.auth.device_token_ttl,
    ) {
        Ok(t) => t,
        Err(e) => {
            error!("failed to generate device token: {e}");
            return;
        }
    };

    let response = json!({
        "msg_type": "register_response",
        "device_id": device.device_id,
        "auth_token": token,
    });
    if tx.send(response.to_string()).await.is_err() {
        return;
    }

    // 5. Register in WS registry
    state.ws_registry.insert(device.id, tx.clone()).await;

    // 6. Subscribe to command channel via Redis
    let redis_url = state.config.redis.url.clone();
    let device_id_for_cmd = device.id;
    let tx_for_cmd = tx.clone();
    tokio::spawn(async move {
        subscribe_commands(redis_url, device_id_for_cmd, tx_for_cmd).await;
    });

    // 7. Setup intervals
    let mut ping_interval = interval(Duration::from_secs(30));
    let token_refresh_secs = state.config.auth.device_token_ttl.saturating_sub(120); // refresh 2min early
    let mut token_refresh = interval(Duration::from_secs(token_refresh_secs.max(60)));
    let mut telemetry_counter: u32 = 0;
    let db_sample_rate = state.config.telemetry.db_sample_rate;

    // 8. Main message loop
    loop {
        tokio::select! {
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_telemetry_msg(&text, &device, &state, &mut telemetry_counter, db_sample_rate).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        info!(device_id = %device.device_id, "device disconnected");
                        break;
                    }
                    Some(Ok(Message::Pong(_))) => {} // expected
                    Some(Err(e)) => {
                        warn!("WebSocket error for {}: {e}", device.device_id);
                        break;
                    }
                    _ => {}
                }
            }
            _ = ping_interval.tick() => {
                if tx.send("__ping__".to_string()).await.is_err() {
                    break;
                }
            }
            _ = token_refresh.tick() => {
                if let Ok(new_token) = generate_device_token(
                    device.id,
                    &device.device_id,
                    &state.config.auth.jwt_secret,
                    state.config.auth.device_token_ttl,
                ) {
                    let msg = json!({
                        "msg_type": "register_response",
                        "device_id": device.device_id,
                        "auth_token": new_token,
                    });
                    if tx.send(msg.to_string()).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    // 9. Cleanup on disconnect
    state.ws_registry.remove(device.id).await;
    if let Err(e) = Device::set_status(device.id, "offline", &state.db).await {
        error!("failed to set device offline: {e}");
    }
    let _ = AuditLog::log_device_event(&state.db, device.id, "device.disconnect", None).await;
}

async fn handle_telemetry_msg(
    text: &str,
    device: &Device,
    state: &AppState,
    counter: &mut u32,
    db_sample_rate: u32,
) {
    let report: TelemetryReport = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(_) => return,
    };

    // Update Redis live cache
    let redis_key = format!("telemetry:{}", device.id);
    let mut redis_conn = state.redis.clone();
    let _: std::result::Result<(), _> = redis::cmd("SET")
        .arg(&redis_key)
        .arg(text)
        .arg("EX")
        .arg(30u64)
        .query_async(&mut redis_conn)
        .await;

    // Update device last_state
    let _ = Device::update_telemetry_state(device.id, &report.state, &state.db).await;

    // Periodically persist to DB
    *counter += 1;
    if *counter >= db_sample_rate {
        *counter = 0;
        let _ = TelemetryRecord::insert(device.id, &report, &state.db).await;
    }
}

async fn subscribe_commands(redis_url: String, device_id: Uuid, tx: tokio::sync::mpsc::Sender<String>) {
    let client = match redis::Client::open(redis_url) {
        Ok(c) => c,
        Err(e) => {
            error!("failed to open Redis client for command subscription: {e}");
            return;
        }
    };
    let mut pubsub = match client.get_async_pubsub().await {
        Ok(p) => p,
        Err(e) => {
            error!("failed to get pubsub connection: {e}");
            return;
        }
    };
    let channel = format!("commands:{device_id}");
    if let Err(e) = pubsub.subscribe(&channel).await {
        error!("failed to subscribe to {channel}: {e}");
        return;
    }

    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        if let Ok(payload) = msg.get_payload::<String>() {
            if tx.send(payload).await.is_err() {
                break;
            }
        }
    }
}
