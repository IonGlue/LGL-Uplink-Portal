use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Organization {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct OrgWithCounts {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub device_count: i64,
    pub user_count: i64,
}

impl Organization {
    pub async fn find_by_id(id: Uuid, db: &PgPool) -> Result<Option<Self>> {
        Ok(sqlx::query_as!(
            Organization,
            "SELECT id, name, slug, created_at, updated_at FROM organizations WHERE id = $1",
            id
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn find_with_counts(id: Uuid, db: &PgPool) -> Result<Option<OrgWithCounts>> {
        Ok(sqlx::query_as!(
            OrgWithCounts,
            r#"SELECT
                o.id,
                o.name,
                o.slug,
                COUNT(DISTINCT d.id) AS "device_count!",
                COUNT(DISTINCT u.id) AS "user_count!"
            FROM organizations o
            LEFT JOIN devices d ON d.org_id = o.id
            LEFT JOIN users u ON u.org_id = o.id
            WHERE o.id = $1
            GROUP BY o.id"#,
            id
        )
        .fetch_optional(db)
        .await?)
    }

    pub async fn create(name: &str, slug: &str, db: &PgPool) -> Result<Self> {
        Ok(sqlx::query_as!(
            Organization,
            "INSERT INTO organizations (name, slug) VALUES ($1, $2)
             RETURNING id, name, slug, created_at, updated_at",
            name,
            slug
        )
        .fetch_one(db)
        .await?)
    }
}
