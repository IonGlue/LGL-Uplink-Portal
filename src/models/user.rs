use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub display_name: String,
    pub role: String,
    pub org_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct UserPublic {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub org_id: Uuid,
}

impl From<User> for UserPublic {
    fn from(u: User) -> Self {
        UserPublic {
            id: u.id,
            email: u.email,
            display_name: u.display_name,
            role: u.role,
            org_id: u.org_id,
        }
    }
}

impl User {
    pub async fn find_by_id(id: Uuid, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as!(
            User,
            "SELECT id, email, password_hash, display_name, role, org_id, created_at, updated_at
             FROM users WHERE id = $1",
            id
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn find_by_email(email: &str, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as!(
            User,
            "SELECT id, email, password_hash, display_name, role, org_id, created_at, updated_at
             FROM users WHERE email = $1",
            email
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn list_by_org(org_id: Uuid, db: &PgPool) -> Result<Vec<Self>> {
        Ok(sqlx::query_as!(
            User,
            "SELECT id, email, password_hash, display_name, role, org_id, created_at, updated_at
             FROM users WHERE org_id = $1 ORDER BY created_at",
            org_id
        )
        .fetch_all(db)
        .await?)
    }

    pub async fn create(
        email: &str,
        password_hash: &str,
        display_name: &str,
        role: &str,
        org_id: Uuid,
        db: &PgPool,
    ) -> Result<Self> {
        Ok(sqlx::query_as!(
            User,
            "INSERT INTO users (email, password_hash, display_name, role, org_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, email, password_hash, display_name, role, org_id, created_at, updated_at",
            email, password_hash, display_name, role, org_id
        )
        .fetch_one(db)
        .await?)
    }

    pub async fn update(
        id: Uuid,
        display_name: Option<&str>,
        role: Option<&str>,
        db: &PgPool,
    ) -> Result<Option<Self>> {
        Ok(sqlx::query_as!(
            User,
            "UPDATE users SET
                display_name = COALESCE($2, display_name),
                role = COALESCE($3, role),
                updated_at = now()
             WHERE id = $1
             RETURNING id, email, password_hash, display_name, role, org_id, created_at, updated_at",
            id, display_name, role
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn delete(id: Uuid, db: &PgPool) -> Result<bool> {
        let result = sqlx::query!("DELETE FROM users WHERE id = $1", id)
            .execute(db)
            .await?;
        Ok(result.rows_affected() > 0)
    }
}
