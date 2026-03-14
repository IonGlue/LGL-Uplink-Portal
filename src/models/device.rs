use chrono::{DateTime, Utc};
use rand::Rng;
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
    pub nickname: Option<String>,
    pub version: String,
    pub org_id: Option<Uuid>,
    pub status: String,
    pub last_state: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub registered_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // Enrollment
    pub enrollment_state: String,
    pub enrollment_code: Option<String>,
    pub enrolled_at: Option<DateTime<Utc>>,
    pub enrolled_by: Option<Uuid>,
}

impl Device {
    /// Generate a random 10-character uppercase alphanumeric enrollment code.
    /// 36^10 ≈ 3.6 trillion combinations.
    pub fn generate_code() -> String {
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let mut rng = rand::thread_rng();
        (0..10)
            .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
            .collect()
    }

    pub async fn find_by_id(id: Uuid, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as::<_, Device>(
            "SELECT id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at,
                    enrollment_state, enrollment_code, enrolled_at, enrolled_by
             FROM devices WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(db)
        .await?)
    }

    pub async fn find_by_device_id(device_id: &str, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as::<_, Device>(
            "SELECT id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at,
                    enrollment_state, enrollment_code, enrolled_at, enrolled_by
             FROM devices WHERE device_id = $1",
        )
        .bind(device_id)
        .fetch_optional(db)
        .await?)
    }

    pub async fn list_by_org(
        org_id: Uuid,
        status_filter: Option<&str>,
        state_filter: Option<&str>,
        db: &PgPool,
    ) -> Result<Vec<Self>> {
        Ok(sqlx::query_as::<_, Device>(
            "SELECT id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at,
                    enrollment_state, enrollment_code, enrolled_at, enrolled_by
             FROM devices
             WHERE org_id = $1
               AND ($2::text IS NULL OR status = $2)
               AND ($3::text IS NULL OR last_state = $3)
             ORDER BY registered_at",
        )
        .bind(org_id)
        .bind(status_filter)
        .bind(state_filter)
        .fetch_all(db)
        .await?)
    }

    pub async fn list_all(
        status_filter: Option<&str>,
        state_filter: Option<&str>,
        db: &PgPool,
    ) -> Result<Vec<Self>> {
        Ok(sqlx::query_as::<_, Device>(
            "SELECT id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at,
                    enrollment_state, enrollment_code, enrolled_at, enrolled_by
             FROM devices
             WHERE ($1::text IS NULL OR status = $1)
               AND ($2::text IS NULL OR last_state = $2)
             ORDER BY registered_at",
        )
        .bind(status_filter)
        .bind(state_filter)
        .fetch_all(db)
        .await?)
    }

    pub async fn list_unassigned(db: &PgPool) -> Result<Vec<Self>> {
        Ok(sqlx::query_as::<_, Device>(
            "SELECT id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at,
                    enrollment_state, enrollment_code, enrolled_at, enrolled_by
             FROM devices WHERE org_id IS NULL ORDER BY registered_at",
        )
        .fetch_all(db)
        .await?)
    }

    /// List devices waiting for admin enrollment approval.
    pub async fn list_pending(db: &PgPool) -> Result<Vec<Self>> {
        Ok(sqlx::query_as::<_, Device>(
            "SELECT id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                    last_state, last_seen_at, registered_at, updated_at,
                    enrollment_state, enrollment_code, enrolled_at, enrolled_by
             FROM devices WHERE enrollment_state = 'pending' ORDER BY registered_at",
        )
        .fetch_all(db)
        .await?)
    }

    /// Register a brand-new device or update a reconnecting one.
    /// Returns (device, is_brand_new).
    pub async fn register_or_update(
        device_id: &str,
        hardware_id: &str,
        hostname: &str,
        version: &str,
        db: &PgPool,
    ) -> Result<(Self, bool)> {
        let existing = Self::find_by_device_id(device_id, db).await?;
        match existing {
            None => {
                let code = Self::generate_code();
                let device = sqlx::query_as::<_, Device>(
                    "INSERT INTO devices
                        (device_id, hardware_id, hostname, version, status,
                         last_seen_at, enrollment_state, enrollment_code)
                     VALUES ($1, $2, $3, $4, 'online', now(), 'pending', $5)
                     RETURNING id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                               last_state, last_seen_at, registered_at, updated_at,
                               enrollment_state, enrollment_code, enrolled_at, enrolled_by",
                )
                .bind(device_id)
                .bind(hardware_id)
                .bind(hostname)
                .bind(version)
                .bind(code)
                .fetch_one(db)
                .await?;
                Ok((device, true))
            }
            Some(existing) => {
                let device = sqlx::query_as::<_, Device>(
                    "UPDATE devices SET
                        hardware_id = $2,
                        hostname = $3,
                        version = $4,
                        status = 'online',
                        last_seen_at = now(),
                        updated_at = now()
                     WHERE id = $1
                     RETURNING id, device_id, hardware_id, hostname, nickname, version, org_id, status,
                               last_state, last_seen_at, registered_at, updated_at,
                               enrollment_state, enrollment_code, enrolled_at, enrolled_by",
                )
                .bind(existing.id)
                .bind(hardware_id)
                .bind(hostname)
                .bind(version)
                .fetch_one(db)
                .await?;
                Ok((device, false))
            }
        }
    }

    /// Admin approves a pending device. Returns Err if code doesn't match.
    pub async fn enroll(id: Uuid, submitted_code: &str, admin_id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE devices SET
                enrollment_state = 'enrolled',
                enrolled_at = now(),
                enrolled_by = $3,
                updated_at = now()
             WHERE id = $1
               AND enrollment_state = 'pending'
               AND enrollment_code = $2",
        )
        .bind(id)
        .bind(submitted_code)
        .bind(admin_id)
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Admin rejects a pending device.
    pub async fn reject(id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE devices SET
                enrollment_state = 'rejected',
                updated_at = now()
             WHERE id = $1 AND enrollment_state = 'pending'",
        )
        .bind(id)
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn update_telemetry_state(id: Uuid, state: &str, db: &PgPool) -> Result<()> {
        sqlx::query(
            "UPDATE devices SET last_state = $2, last_seen_at = now(), updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(state)
        .execute(db)
        .await?;
        Ok(())
    }

    pub async fn set_status(id: Uuid, status: &str, db: &PgPool) -> Result<()> {
        sqlx::query(
            "UPDATE devices SET status = $2, last_seen_at = now(), updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(status)
        .execute(db)
        .await?;
        Ok(())
    }

    pub async fn assign_to_org(id: Uuid, org_id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE devices SET org_id = $2, updated_at = now() WHERE id = $1 AND org_id IS NULL",
        )
        .bind(id)
        .bind(org_id)
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn decommission(id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE devices SET org_id = NULL, status = 'offline', updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Set or clear the human-readable nickname for a device.
    pub async fn update_nickname(id: Uuid, nickname: Option<&str>, db: &PgPool) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE devices SET nickname = $2, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(nickname)
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }
}
