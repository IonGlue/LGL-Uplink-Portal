use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{
        jwt::generate_user_token,
        middleware::AuthUser,
        password::verify_password,
    },
    error::{AppError, Result},
    models::user::{User, UserPublic},
    AppState,
};

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub user: UserPublic,
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>> {
    let user = User::find_by_email(&body.email, &state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;

    if !verify_password(&body.password, &user.password_hash)? {
        return Err(AppError::Unauthorized);
    }

    let token = generate_user_token(
        user.id,
        user.org_id,
        &user.role,
        &state.config.auth.jwt_secret,
        state.config.auth.user_token_ttl,
    )?;

    Ok(Json(LoginResponse {
        token,
        user: user.into(),
    }))
}

#[derive(Serialize)]
pub struct RefreshResponse {
    pub token: String,
}

pub async fn refresh(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<RefreshResponse>> {
    let token = generate_user_token(
        claims.sub,
        claims.org_id,
        &claims.role,
        &state.config.auth.jwt_secret,
        state.config.auth.user_token_ttl,
    )?;
    Ok(Json(RefreshResponse { token }))
}

pub async fn me(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<UserPublic>> {
    let user = User::find_by_id(claims.sub, &state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(user.into()))
}
