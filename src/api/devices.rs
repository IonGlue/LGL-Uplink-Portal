use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::middleware::{require_admin, AuthUser},
    error::{AppError, Result},
    models::{assignment::Assignment, claim::ControlClaim, device::Device},
    AppState,
};

#[derive(Deserialize)]
pub struct DeviceFilter {
    pub status: Option<String>,
    pub state: Option<String>,
}

#[derive(Serialize)]
pub struct DeviceResponse {
    pub id: Uuid,
    pub device_id: String,
    pub hostname: String,
    pub version: String,
    pub status: String,
    pub last_state: String,
    pub last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
    pub assigned_users: Vec<Uuid>,
    pub control_claimed_by: Option<Uuid>,
}

async fn enrich_device(device: Device, state: &AppState) -> Result<DeviceResponse> {
    let assigned_users = Assignment::user_ids_for_device(device.id, &state.db).await?;
    let claim = ControlClaim::find_for_device(device.id, &state.db).await?;
    let control_claimed_by = claim
        .filter(|c| c.expires_at > chrono::Utc::now())
        .map(|c| c.user_id);

    Ok(DeviceResponse {
        id: device.id,
        device_id: device.device_id,
        hostname: device.hostname,
        version: device.version,
        status: device.status,
        last_state: device.last_state,
        last_seen_at: device.last_seen_at,
        assigned_users,
        control_claimed_by,
    })
}

pub async fn list_devices(
    State(state): State<AppState>,
    Query(filter): Query<DeviceFilter>,
) -> Result<Json<serde_json::Value>> {
    let devices = Device::list_all(
        filter.status.as_deref(),
        filter.state.as_deref(),
        &state.db,
    )
    .await?;

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
