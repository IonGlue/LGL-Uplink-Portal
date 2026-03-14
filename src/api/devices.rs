use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::middleware::{require_admin, AuthUser},
    error::{AppError, Result},
    models::{assignment::Assignment, audit::AuditLog, claim::ControlClaim, device::Device},
    AppState,
};

#[derive(Deserialize)]
pub struct DeviceFilter {
    pub status: Option<String>,
    pub state: Option<String>,
}

/// Computed connection status combining WS status + encoder state.
/// "offline"    – device WebSocket is not connected
/// "connecting" – device is online but encoder is starting/connecting a stream
/// "streaming"  – SRT stream is live and pushing to a destination
/// "online"     – device is connected to portal, encoder is idle/stopped
fn compute_connection_status(status: &str, last_state: &str) -> String {
    if status != "online" {
        return "offline".to_string();
    }
    match last_state {
        "streaming"  => "streaming".to_string(),
        "starting" | "connecting" => "connecting".to_string(),
        _ => "online".to_string(),
    }
}

#[derive(Serialize)]
pub struct DeviceResponse {
    pub id: Uuid,
    pub device_id: String,
    pub hostname: String,
    pub nickname: Option<String>,
    pub version: String,
    /// Raw WS status: "online" | "offline"
    pub status: String,
    /// Encoder state: "idle" | "starting" | "streaming" | "stopping" | "error"
    pub last_state: String,
    /// Combined status: "offline" | "online" | "connecting" | "streaming"
    pub connection_status: String,
    pub last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
    pub assigned_users: Vec<Uuid>,
    pub control_claimed_by: Option<Uuid>,
    pub enrollment_state: String,
}

async fn enrich_device(device: Device, state: &AppState) -> Result<DeviceResponse> {
    let assigned_users = Assignment::user_ids_for_device(device.id, &state.db).await?;
    let claim = ControlClaim::find_for_device(device.id, &state.db).await?;
    let control_claimed_by = claim
        .filter(|c| c.expires_at > chrono::Utc::now())
        .map(|c| c.user_id);

    let connection_status = compute_connection_status(&device.status, &device.last_state);

    Ok(DeviceResponse {
        id: device.id,
        device_id: device.device_id,
        hostname: device.hostname,
        nickname: device.nickname,
        version: device.version,
        status: device.status,
        last_state: device.last_state,
        connection_status,
        last_seen_at: device.last_seen_at,
        assigned_users,
        control_claimed_by,
        enrollment_state: device.enrollment_state,
    })
}

pub async fn list_devices(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(filter): Query<DeviceFilter>,
) -> Result<Json<serde_json::Value>> {
    // Admins see all devices; regular users see only their org's devices.
    let devices = if claims.role == "admin" {
        Device::list_all(
            filter.status.as_deref(),
            filter.state.as_deref(),
            &state.db,
        )
        .await?
    } else {
        Device::list_by_org(
            claims.org_id,
            filter.status.as_deref(),
            filter.state.as_deref(),
            &state.db,
        )
        .await?
    };

    let mut responses = Vec::new();
    for d in devices {
        responses.push(enrich_device(d, &state).await?);
    }

    Ok(Json(serde_json::json!({ "devices": responses })))
}

pub async fn get_device(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<DeviceResponse>> {
    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    Ok(Json(enrich_device(device, &state).await?))
}

pub async fn list_unassigned_devices(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;
    let devices = Device::list_unassigned(&state.db).await?;
    Ok(Json(serde_json::json!({ "devices": devices })))
}

/// List all devices pending enrollment approval (admin only).
pub async fn list_pending_devices(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;
    let devices = Device::list_pending(&state.db).await?;
    // Return minimal info including enrollment code so admin can verify
    let resp: Vec<_> = devices
        .into_iter()
        .map(|d| serde_json::json!({
            "id": d.id,
            "device_id": d.device_id,
            "hardware_id": d.hardware_id,
            "hostname": d.hostname,
            "version": d.version,
            "enrollment_code": d.enrollment_code,
            "status": d.status,
            "registered_at": d.registered_at,
        }))
        .collect();
    Ok(Json(serde_json::json!({ "devices": resp })))
}

#[derive(Deserialize)]
pub struct EnrollBody {
    pub code: String,
}

/// Admin confirms a device by submitting the matching 5-digit code.
pub async fn enroll_device(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
    Json(body): Json<EnrollBody>,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;

    let enrolled = Device::enroll(device_id, &body.code, claims.sub, &state.db).await?;
    if !enrolled {
        return Err(AppError::InvalidCommand(
            "code does not match or device is not pending enrollment".to_string(),
        ));
    }

    // Notify the device over Redis pub/sub so it gets the approval immediately
    let channel = format!("enrollment:{device_id}");
    let mut redis_conn = state.redis.clone();
    let _: Result<()> = redis::cmd("PUBLISH")
        .arg(&channel)
        .arg("approved")
        .query_async(&mut redis_conn)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")));

    let _ = AuditLog::log_user_command(
        &state.db,
        claims.sub,
        device_id,
        "device.enroll",
        None,
    )
    .await;

    Ok(Json(serde_json::json!({ "enrolled": true })))
}

/// Admin rejects a pending device.
pub async fn reject_device(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;

    let rejected = Device::reject(device_id, &state.db).await?;
    if !rejected {
        return Err(AppError::NotFound);
    }

    // Notify the connected device immediately
    let channel = format!("enrollment:{device_id}");
    let mut redis_conn = state.redis.clone();
    let _: std::result::Result<(), _> = redis::cmd("PUBLISH")
        .arg(&channel)
        .arg("rejected")
        .query_async(&mut redis_conn)
        .await;

    let _ = AuditLog::log_user_command(
        &state.db,
        claims.sub,
        device_id,
        "device.reject",
        None,
    )
    .await;

    Ok(Json(serde_json::json!({ "rejected": true })))
}

pub async fn claim_device_to_org(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;

    let assigned = Device::assign_to_org(device_id, claims.org_id, &state.db).await?;
    if !assigned {
        return Err(AppError::Conflict("device is already assigned to an org".to_string()));
    }

    Ok(Json(serde_json::json!({ "assigned": true })))
}

pub async fn decommission_device(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;

    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    Device::decommission(device_id, &state.db).await?;
    Ok(Json(serde_json::json!({ "decommissioned": true })))
}

#[derive(Deserialize)]
pub struct NicknameBody {
    /// Set to null/absent to clear the nickname.
    pub nickname: Option<String>,
}

/// Update the user-facing nickname for a device.
pub async fn update_nickname(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
    Json(body): Json<NicknameBody>,
) -> Result<Json<serde_json::Value>> {
    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    // Admins can rename any device in their org; regular users cannot rename devices.
    require_admin(&claims)?;
    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    // Validate length
    if let Some(ref name) = body.nickname {
        if name.len() > 100 {
            return Err(AppError::InvalidCommand("nickname must be <= 100 characters".to_string()));
        }
    }

    Device::update_nickname(device_id, body.nickname.as_deref(), &state.db).await?;

    let _ = AuditLog::log_user_command(
        &state.db,
        claims.sub,
        device_id,
        "device.set_nickname",
        body.nickname.as_deref().map(|n| serde_json::json!({ "nickname": n })).as_ref(),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}
