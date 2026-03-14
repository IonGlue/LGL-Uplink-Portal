use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, Result};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ControlClaim {
    pub id: Uuid,
    pub device_id: Uuid,
    pub user_id: Uuid,
    pub claimed_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl ControlClaim {
    pub async fn find_for_device(device_id: Uuid, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as!(
            ControlClaim,
            "SELECT id, device_id, user_id, claimed_at, expires_at
             FROM control_claims WHERE device_id = $1",
            device_id
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn claim(
        device_id: Uuid,
        user_id: Uuid,
        ttl_secs: i64,
        db: &PgPool,
    ) -> Result<Self> {
        let existing = Self::find_for_device(device_id, db).await?;
        let expires_at = Utc::now() + Duration::seconds(ttl_secs);

        match existing {
            Some(claim) if claim.expires_at > Utc::now() && claim.user_id != user_id => {
                // Active claim held by another user — find their display name
                let row = sqlx::query!(
                    "SELECT display_name FROM users WHERE id = $1",
                    claim.user_id
                )
                .fetch_optional(db)
                .await?;
                let by_name = row.map(|r| r.display_name).unwrap_or_default();
                return Err(AppError::DeviceClaimed {
                    by: claim.user_id,
                    by_name,
                    expires_at: claim.expires_at,
                });
            }
            Some(claim) if claim.user_id == user_id => {
                // Same user — refresh expiry
                Ok(sqlx::query_as!(
                    ControlClaim,
                    "UPDATE control_claims SET expires_at = $1 WHERE id = $2
                     RETURNING id, device_id, user_id, claimed_at, expires_at",
                    expires_at, claim.id
                )
                .fetch_one(db)
                .await?)
            }
            _ => {
                // Expired or no claim — delete any stale entry and insert fresh
                sqlx::query!("DELETE FROM control_claims WHERE device_id = $1", device_id)
                    .execute(db)
                    .await?;
                Ok(sqlx::query_as!(
                    ControlClaim,
                    "INSERT INTO control_claims (device_id, user_id, expires_at)
                     VALUES ($1, $2, $3)
                     RETURNING id, device_id, user_id, claimed_at, expires_at",
                    device_id, user_id, expires_at
                )
                .fetch_one(db)
                .await?)
            }
        }
    }

    pub async fn release(device_id: Uuid, user_id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query!(
            "DELETE FROM control_claims WHERE device_id = $1 AND user_id = $2",
            device_id, user_id
        )
        .execute(db)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn force_release(device_id: Uuid, db: &PgPool) -> Result<()> {
        sqlx::query!("DELETE FROM control_claims WHERE device_id = $1", device_id)
            .execute(db)
            .await?;
        Ok(())
    }

    pub async fn refresh_expiry(device_id: Uuid, user_id: Uuid, ttl_secs: i64, db: &PgPool) -> Result<()> {
        let expires_at = Utc::now() + Duration::seconds(ttl_secs);
        sqlx::query!(
            "UPDATE control_claims SET expires_at = $3 WHERE device_id = $1 AND user_id = $2",
            device_id, user_id, expires_at
        )
        .execute(db)
        .await?;
        Ok(())
    }

    pub async fn validate_active(device_id: Uuid, user_id: Uuid, db: &PgPool) -> Result<()> {
        let claim = Self::find_for_device(device_id, db).await?;
        match claim {
            Some(c) if c.user_id == user_id && c.expires_at > Utc::now() => Ok(()),
            _ => Err(AppError::NoControlClaim),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claim_expiry_logic() {
        let future = Utc::now() + Duration::seconds(300);
        let past = Utc::now() - Duration::seconds(1);
        assert!(future > Utc::now());
        assert!(past < Utc::now());
    }
}
