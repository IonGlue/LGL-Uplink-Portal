use sqlx::PgPool;
use std::time::Duration;
use tracing::info;

pub async fn run(db: PgPool, interval_secs: u64) {
    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    loop {
        ticker.tick().await;
        match sqlx::query!(
            "UPDATE devices SET status = 'offline', updated_at = now()
             WHERE status = 'online' AND last_seen_at < now() - interval '60 seconds'"
        )
        .execute(&db)
        .await
        {
            Ok(result) if result.rows_affected() > 0 => {
                info!("marked {} device(s) offline", result.rows_affected());
            }
            Err(e) => tracing::error!("device offline job error: {e}"),
            _ => {}
        }
    }
}
