use sqlx::PgPool;
use std::time::Duration;
use tracing::info;

pub async fn run(db: PgPool, interval_secs: u64) {
    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    loop {
        ticker.tick().await;
        match sqlx::query!("DELETE FROM control_claims WHERE expires_at < now()")
            .execute(&db)
            .await
        {
            Ok(result) if result.rows_affected() > 0 => {
                info!("expired {} control claim(s)", result.rows_affected());
            }
            Err(e) => tracing::error!("claim expiry job error: {e}"),
            _ => {}
        }
    }
}
