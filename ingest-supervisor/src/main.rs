use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::sync::RwLock;

mod config;
mod supervisor;
mod routing;
mod port_pool;
mod api;

use config::Config;
use supervisor::Supervisor;
use routing::RoutingTable;
use port_pool::PortPool;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    let config_path = std::env::args().nth(1)
        .unwrap_or_else(|| "config/ingest.toml".to_string());

    let config = Config::load(&config_path)
        .with_context(|| format!("failed to load config: {config_path}"))?;

    log::info!("LGL Ingest supervisor starting");
    log::info!("  supervisor API: 127.0.0.1:{}", config.supervisor.api_port);
    log::info!("  internal port range: {}-{}",
        config.supervisor.internal_port_start,
        config.supervisor.internal_port_end);

    let port_pool = Arc::new(RwLock::new(PortPool::new(
        config.supervisor.internal_port_start,
        config.supervisor.internal_port_end,
    )));

    let routing = Arc::new(RwLock::new(RoutingTable::new()));

    let supervisor = Arc::new(RwLock::new(Supervisor::new(
        config.clone(),
        port_pool.clone(),
        routing.clone(),
    )));

    // Start the supervision loop in background
    let sup_clone = supervisor.clone();
    tokio::spawn(async move {
        if let Err(e) = sup_clone.write().await.supervision_loop().await {
            log::error!("supervision loop error: {e}");
        }
    });

    // Start the local REST API
    let api_addr = format!("127.0.0.1:{}", config.supervisor.api_port);
    log::info!("starting supervisor API on {api_addr}");

    api::serve(api_addr, supervisor, routing, port_pool).await
}
