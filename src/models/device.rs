use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Device {
    pub id: Uuid,
    pub device_id: String,
    pub hardware_id: String,
    pub hostname: String,
    pub version: String,
    pub org_id: Option<Uuid>,
    pub status: String,
    pub last_state: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub registered_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Device {
    pub async fn find_by_id(id: Uuid, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as!(
            Device,
            "SELECT id, device_id, hardware_id, hostname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at
             FROM devices WHERE id = $1",
            id
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn find_by_device_id(device_id: &str, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as!(
            Device,
            "SELECT id, device_id, hardware_id, hostname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at
             FROM devices WHERE device_id = $1",
            device_id
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn list_by_org(
        org_id: Uuid,
        status_filter: Option<&str>,
        state_filter: Option<&str>,
        db: &PgPool,
    ) -> Result<Vec<Self>> {
        Ok(sqlx::query_as!(
            Device,
            "SELECT id, device_id, hardware_id, hostname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at
             FROM devices
             WHERE org_id = $1
               AND ($2::text IS NULL OR status = $2)
               AND ($3::text IS NULL OR last_state = $3)
             ORDER BY registered_at",
            org_id, status_filter, state_filter
        )
        .fetch_all(db)
        .await?)
    }

    pub async fn list_all(
        status_filter: Option<&str>,
        state_filter: Option<&str>,
        db: &PgPool,
    ) -> Result<Vec<Self>> {
        Ok(sqlx::query_as!(
            Device,
            "SELECT id, device_id, hardware_id, hostname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at
             FROM devices
             WHERE ($1::text IS NULL OR status = $1)
               AND ($2::text IS NULL OR last_state = $2)
             ORDER BY registered_at",
            status_filter, state_filter
        )
        .fetch_all(db)
        .await?)
    }

    pub async fn list_unassigned(db: &PgPool) -> Result<Vec<Self>> {
        Ok(sqlx::query_as!(
            Device,
            "SELECT id, device_id, hardware_id, hostname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at
             FROM devices WHERE org_id IS NULL ORDER BY registered_at"
        )
        .fetch_all(db)
        .await?)
    }

    pub async fn register_or_update(
        device_id: &str,
        hardware_id: &str,
        hostname: &str,
        version: &str,
        db: &PgPool,
    ) -> Result<(Self, bool)> {
        // Returns (device, is_new)
        let existing = Self::find_by_device_id(device_id, db).await?;
        match existing {
            None => {
                let device = sqlx::query_as!(
                    Device,
                    "INSERT INTO devices (device_id, hardware_id, hostname, version, status, last_seen_at)
                     VALUES ($1, $2, $3, $4, 'online', now())
                     RETURNING id, device_id, hardware_id, hostname, version, org_id, status,
                               last_state, last_seen_at, registered_at, updated_at",
                    device_id, hardware_id, hostname, version
                )
                .fetch_one(db)
                .await?;
                Ok((device, true))
            }
            Some(existing) => {
                let device = sqlx::query_as!(
                    Device,
                    "UPDATE devices SET
                        hardware_id = $2,
                        hostname = $3,
                        version = $4,
                        status = 'online',
                        last_seen_at = now(),
                        updated_at = now()
                     WHERE id = $1
                     RETURNING id, device_id, hardware_id, hostname, version, org_id, status,
                               last_state, last_seen_at, registered_at, updated_at",
                    existing.id, hardware_id, hostname, version
                )
                .fetch_one(db)
                .await?;
                let hardware_changed = existing.hardware_id != hardware_id;
                Ok((device, hardware_changed))
            }
        }
    }

    pub async fn update_telemetry_state(id: Uuid, state: &str, db: &PgPool) -> Result<()> {
        sqlx::query!(
            "UPDATE devices SET last_state = $2, last_seen_at = now(), updated_at = now() WHERE id = $1",
            id, state
        )
        .execute(db)
        .await?;
        Ok(())
    }

    pub async fn set_status(id: Uuid, status: &str, db: &PgPool) -> Result<()> {
        sqlx::query!(
            "UPDATE devices SET status = $2, last_seen_at = now(), updated_at = now() WHERE id = $1",
            id, status
        )
        .execute(db)
        .await?;
        Ok(())
    }

    pub async fn assign_to_org(id: Uuid, org_id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query!(
            "UPDATE devices SET org_id = $2, updated_at = now() WHERE id = $1 AND org_id IS NULL",
            id, org_id
        )
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn decommission(id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query!(
            "UPDATE devices SET org_id = NULL, status = 'offline', updated_at = now() WHERE id = $1",
            id
        )
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }
}
