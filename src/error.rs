use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("not found")]
    NotFound,

    #[error("unauthorized")]
    Unauthorized,

    #[error("forbidden")]
    Forbidden,

    #[error("device is already claimed")]
    DeviceClaimed {
        by: Uuid,
        by_name: String,
        expires_at: chrono::DateTime<chrono::Utc>,
    },

    #[error("no active control claim")]
    NoControlClaim,

    #[error("invalid command: {0}")]
    InvalidCommand(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("validation error: {0}")]
    Validation(String),

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("redis error: {0}")]
    Redis(#[from] redis::RedisError),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, body) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, json!({"error": "not found"})),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"})),
            AppError::Forbidden => (StatusCode::FORBIDDEN, json!({"error": "forbidden"})),
            AppError::DeviceClaimed { by, by_name, expires_at } => (
                StatusCode::CONFLICT,
                json!({
                    "error": "device is claimed by another user",
                    "claimed_by": by,
                    "claimed_by_name": by_name,
                    "expires_at": expires_at,
                }),
            ),
            AppError::NoControlClaim => (
                StatusCode::FORBIDDEN,
                json!({"error": "no active control claim"}),
            ),
            AppError::InvalidCommand(msg) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": format!("invalid command: {msg}")}),
            ),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, json!({"error": msg})),
            AppError::Validation(msg) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({"error": msg}),
            ),
            AppError::Database(e) => {
                tracing::error!("database error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, json!({"error": "internal server error"}))
            }
            AppError::Redis(e) => {
                tracing::error!("redis error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, json!({"error": "internal server error"}))
            }
            AppError::Internal(e) => {
                tracing::error!("internal error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, json!({"error": "internal server error"}))
            }
        };
        (status, Json(body)).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
