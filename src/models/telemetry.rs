use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct TelemetryRecord {
    pub id: i64,
    pub device_id: Uuid,
    pub ts: DateTime<Utc>,
    pub state: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

/// Wire format for a telemetry message from a device
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TelemetryReport {
    pub ts: i64,
    pub state: String,
    pub paths: Vec<PathStats>,
    pub encoder: Option<EncoderStats>,
    pub uptime_secs: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PathStats {
    pub interface: String,
    pub bitrate_kbps: u64,
    pub rtt_ms: f64,
    pub loss_pct: f64,
    pub in_flight: u64,
    pub window: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EncoderStats {
    pub pipeline: String,
    pub bitrate_kbps: u64,
    pub fps: f64,
    pub resolution: String,
}

impl TelemetryReport {
    pub fn timestamp(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.ts, 0).unwrap_or_else(Utc::now)
    }
}

impl TelemetryRecord {
    pub async fn insert(device_id: Uuid, report: &TelemetryReport, db: &PgPool) -> Result<()> {
        let ts = report.timestamp();
        let payload = serde_json::to_value(report).unwrap_or_default();
        sqlx::query!(
            "INSERT INTO telemetry (device_id, ts, state, payload) VALUES ($1, $2, $3, $4)",
            device_id, ts, report.state, payload
        )
        .execute(db)
        .await?;
        Ok(())
    }

    pub async fn query_history(
        device_id: Uuid,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        db: &PgPool,
    ) -> Result<Vec<Self>> {
        Ok(sqlx::query_as!(
            TelemetryRecord,
            "SELECT id, device_id, ts, state, payload, created_at
             FROM telemetry
             WHERE device_id = $1 AND ts >= $2 AND ts <= $3
             ORDER BY ts",
            device_id, from, to
        )
        .fetch_all(db)
        .await?)
    }
}
