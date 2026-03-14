use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};

use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use redis::aio::ConnectionManager;
use sqlx::PgPool;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod api;
mod auth;
mod config;
mod db;
mod error;
mod jobs;
mod models;
mod ws;

use config::Config;
use ws::registry::WsRegistry;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub redis: ConnectionManager,
    pub config: Arc<Config>,
    pub ws_registry: WsRegistry,
    pub started_at: Arc<Instant>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logging
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load config
    let config_path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("config/ingest.example.toml"));

    let config = Config::load(&config_path)?.from_env_overrides();
    let config = Arc::new(config);

    // Check for seed subcommand
    let args: Vec<String> = std::env::args().collect();
    if args.get(2).map(|s| s.as_str()) == Some("seed") {
        return run_seed(&config, &args).await;
    }

    // DB + migrations
    let db = db::create_pool(&config.database).await?;
    db::run_migrations(&db).await?;
    info!("database migrations complete");

    // Redis
    let redis_client = redis::Client::open(config.redis.url.clone())?;
    let redis = ConnectionManager::new(redis_client).await?;
    info!("redis connected");

    let state = AppState {
        db: db.clone(),
        redis,
        config: config.clone(),
        ws_registry: WsRegistry::new(),
        started_at: Arc::new(Instant::now()),
    };

    // Start background jobs
    tokio::spawn(jobs::claim_expiry::run(db.clone(), config.control.claim_check_interval));
    tokio::spawn(jobs::telemetry_prune::run(
        db.clone(),
        config.telemetry.prune_interval,
        config.telemetry.history_ttl_hours,
    ));
    tokio::spawn(jobs::device_offline::run(db.clone(), 30));

    // Build router
    let ws_path = config.server.ws_path.clone();
    let app = api::router()
        .route(&ws_path, get(ws_upgrade_handler))
        .route("/health", get(health_handler))
        .with_state(state);

    let addr = SocketAddr::new(
        config.server.host.parse()?,
        config.server.port,
    );
    info!("listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn ws_upgrade_handler(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |ws| ws::handler::handle_device_ws(ws, state))
}

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query("SELECT 1").execute(&state.db).await.is_ok();

    let mut redis_conn = state.redis.clone();
    let redis_ok = redis::cmd("PING")
        .query_async::<String>(&mut redis_conn)
        .await
        .map(|r| r == "PONG")
        .unwrap_or(false);

    let uptime_secs = state.started_at.elapsed().as_secs();

    Json(serde_json::json!({
        "status": if db_ok && redis_ok { "ok" } else { "degraded" },
        "db": if db_ok { "connected" } else { "error" },
        "redis": if redis_ok { "connected" } else { "error" },
        "uptime_secs": uptime_secs,
    }))
}

async fn run_seed(config: &Config, args: &[String]) -> anyhow::Result<()> {
    let org_name = get_arg(args, "--org").unwrap_or("Default Org".to_string());
    let email = get_arg(args, "--admin-email").unwrap_or("admin@example.com".to_string());
    let password = get_arg(args, "--admin-password").unwrap_or("changeme".to_string());

    let db = db::create_pool(&config.database).await?;
    db::run_migrations(&db).await?;

    let slug = org_name.to_lowercase().replace(' ', "-");
    let org = models::organization::Organization::create(&org_name, &slug, &db).await?;
    info!("created org: {} ({})", org.name, org.id);

    let password_hash = auth::password::hash_password(&password)?;
    let user = models::user::User::create(&email, &password_hash, "Admin", "admin", org.id, &db).await?;
    info!("created admin user: {} ({})", user.email, user.id);

    println!("Seed complete.");
    println!("  Org:   {} / {}", org.name, org.id);
    println!("  Admin: {} / {}", user.email, user.id);

    Ok(())
}

fn get_arg(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .map(|w| w[1].clone())
}
