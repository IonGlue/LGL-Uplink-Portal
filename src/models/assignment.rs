use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Assignment {
    pub id: Uuid,
    pub device_id: Uuid,
    pub user_id: Uuid,
    pub assigned_at: DateTime<Utc>,
    pub assigned_by: Option<Uuid>,
}

impl Assignment {
    pub async fn list_for_device(device_id: Uuid, db: &PgPool) -> Result<Vec<Self>> {
        Ok(sqlx::query_as!(
            Assignment,
            "SELECT id, device_id, user_id, assigned_at, assigned_by
             FROM device_assignments WHERE device_id = $1",
            device_id
        )
        .fetch_all(db)
        .await?)
    }

    pub async fn create(
        device_id: Uuid,
        user_id: Uuid,
        assigned_by: Uuid,
        db: &PgPool,
    ) -> Result<Self> {
        Ok(sqlx::query_as!(
            Assignment,
            "INSERT INTO device_assignments (device_id, user_id, assigned_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (device_id, user_id) DO UPDATE SET assigned_by = $3
             RETURNING id, device_id, user_id, assigned_at, assigned_by",
            device_id, user_id, assigned_by
        )
        .fetch_one(db)
        .await?)
    }

    pub async fn delete(device_id: Uuid, user_id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query!(
            "DELETE FROM device_assignments WHERE device_id = $1 AND user_id = $2",
            device_id, user_id
        )
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn user_ids_for_device(device_id: Uuid, db: &PgPool) -> Result<Vec<Uuid>> {
        let rows = sqlx::query!(
            "SELECT user_id FROM device_assignments WHERE device_id = $1",
            device_id
        )
        .fetch_all(db)
        .await?;
        Ok(rows.into_iter().map(|r| r.user_id).collect())
    }
}
