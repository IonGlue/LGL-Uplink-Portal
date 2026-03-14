use sqlx::PgPool;
use std::time::Duration;
use tracing::info;

pub async fn run(db: PgPool, interval_secs: u64, history_ttl_hours: i64) {
    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    loop {
        ticker.tick().await;
        match sqlx::query!(
            "DELETE FROM telemetry WHERE created_at < now() - ($1 || ' hours')::interval",
            history_ttl_hours.to_string()
        )
        .execute(&db)
        .await
        {
            Ok(result) if result.rows_affected() > 0 => {
                info!("pruned {} telemetry record(s)", result.rows_affected());
            }
            Err(e) => tracing::error!("telemetry prune job error: {e}"),
            _ => {}
        }
    }
}
