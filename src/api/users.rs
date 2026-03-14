use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    auth::{middleware::{require_admin, AuthUser}, password::hash_password},
    error::{AppError, Result},
    models::user::{User, UserPublic},
    AppState,
};

pub async fn list_users(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<UserPublic>>> {
    let users = User::list_by_org(claims.org_id, &state.db).await?;
    Ok(Json(users.into_iter().map(UserPublic::from).collect()))
}

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub password: String,
}

pub async fn create_user(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<UserPublic>> {
    require_admin(&claims)?;

    if !["admin", "operator", "viewer"].contains(&body.role.as_str()) {
        return Err(AppError::Validation("invalid role".to_string()));
    }

    let password_hash = hash_password(&body.password)?;
    let user = User::create(
        &body.email,
        &password_hash,
        &body.display_name,
        &body.role,
        claims.org_id,
        &state.db,
    )
    .await?;

    Ok(Json(user.into()))
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    pub display_name: Option<String>,
    pub role: Option<String>,
}

pub async fn update_user(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(user_id): Path<Uuid>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<Json<UserPublic>> {
    require_admin(&claims)?;

    // Ensure user is in same org
    let existing = User::find_by_id(user_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if existing.org_id != claims.org_id {
        return Err(AppError::NotFound);
    }

    if let Some(ref role) = body.role {
        if !["admin", "operator", "viewer"].contains(&role.as_str()) {
            return Err(AppError::Validation("invalid role".to_string()));
        }
    }

    let user = User::update(user_id, body.display_name.as_deref(), body.role.as_deref(), &state.db)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(user.into()))
}

pub async fn delete_user(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    require_admin(&claims)?;

    let existing = User::find_by_id(user_id, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if existing.org_id != claims.org_id {
        return Err(AppError::NotFound);
    }
    // Prevent deleting yourself
    if user_id == claims.sub {
        return Err(AppError::Validation("cannot delete yourself".to_string()));
    }

    User::delete(user_id, &state.db).await?;
    Ok(Json(serde_json::json!({"deleted": true})))
}
