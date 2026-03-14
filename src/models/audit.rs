use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct AuditEntry {
    pub id: i64,
    pub actor_type: String,
    pub actor_id: Option<Uuid>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<Uuid>,
    pub details: Option<Value>,
    pub created_at: DateTime<Utc>,
}

pub struct AuditLog;

impl AuditLog {
    pub async fn log(
        db: &PgPool,
        actor_type: &str,
        actor_id: Option<Uuid>,
        action: &str,
        target_type: Option<&str>,
        target_id: Option<Uuid>,
        details: Option<Value>,
    ) -> Result<()> {
        sqlx::query!(
            "INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, $4, $5, $6)",
            actor_type, actor_id, action, target_type, target_id, details
        )
        .execute(db)
        .await?;
        Ok(())
    }

    pub async fn log_device_event(
        db: &PgPool,
        device_uuid: Uuid,
        action: &str,
        details: Option<Value>,
    ) -> Result<()> {
        Self::log(db, "system", None, action, Some("device"), Some(device_uuid), details).await
    }

    pub async fn log_user_command(
        db: &PgPool,
        user_id: Uuid,
        device_uuid: Uuid,
        action: &str,
        details: Option<Value>,
    ) -> Result<()> {
        Self::log(db, "user", Some(user_id), action, Some("device"), Some(device_uuid), details)
            .await
    }
}
