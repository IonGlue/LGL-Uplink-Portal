use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    auth::middleware::{require_admin, AuthUser},
    error::{AppError, Result},
    models::{assignment::Assignment, device::Device},
    AppState,
};

pub async fn list_assignments(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Vec<Assignment>>> {
    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    let assignments = Assignment::list_for_device(device_id, &state.db).await?;
    Ok(Json(assignments))
}

#[derive(Deserialize)]
pub struct AssignRequest {
    pub user_id: Uuid,
}

pub async fn create_assignment(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
    Json(body): Json<AssignRequest>,
) -> Result<Json<Assignment>> {
    require_admin(&claims)?;

    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    let assignment = Assignment::create(device_id, body.user_id, claims.sub, &state.db).await?;
    Ok(Json(assignment))
}

pub async fn delete_assignment(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path((device_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;

    let device = Device::find_by_id(device_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if device.org_id != Some(claims.org_id) {
        return Err(AppError::NotFound);
    }

    let deleted = Assignment::delete(device_id, user_id, &state.db).await?;
    if !deleted {
        return Err(AppError::NotFound);
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}
