use axum::{
    extract::FromRequestParts,
    http::{request::Parts, HeaderMap},
};

use crate::{
    auth::jwt::{validate_user_token, UserClaims},
    error::AppError,
    AppState,
};

pub struct AuthUser(pub UserClaims);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_token(&parts.headers)?;
        let claims = validate_user_token(&token, &state.config.auth.jwt_secret)?;
        Ok(AuthUser(claims))
    }
}

fn extract_bearer_token(headers: &HeaderMap) -> Result<String, AppError> {
    let header = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;

    let token = header
        .strip_prefix("Bearer ")
        .ok_or(AppError::Unauthorized)?;

    Ok(token.to_string())
}

/// Role guard helpers
pub fn require_admin(claims: &UserClaims) -> Result<(), AppError> {
    if claims.role != "admin" {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

pub fn require_operator_or_above(claims: &UserClaims) -> Result<(), AppError> {
    if claims.role == "viewer" {
        return Err(AppError::Forbidden);
    }
    Ok(())
}
