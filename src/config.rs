use axum::http::HeaderMap;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub auth: AuthConfig,
    pub control: ControlConfig,
    pub telemetry: TelemetryConfig,
    pub limits: LimitsConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub ws_path: String,
    /// When true, read client IP from the `CF-Connecting-IP` header instead of
    /// the TCP peer address.  Enable only when traffic arrives exclusively via
    /// Cloudflare Tunnel — never when the service is directly internet-reachable,
    /// because any client could then spoof the header.
    #[serde(default)]
    pub trust_cf_connecting_ip: bool,
}

impl ServerConfig {
    /// Returns the real client IP string, respecting the CF-Connecting-IP header
    /// when `trust_cf_connecting_ip` is enabled.
    pub fn client_ip<'a>(&self, headers: &'a HeaderMap, peer_addr: &'a str) -> &'a str {
        if self.trust_cf_connecting_ip {
            if let Some(v) = headers.get("CF-Connecting-IP").and_then(|v| v.to_str().ok()) {
                return v;
            }
        }
        peer_addr
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RedisConfig {
    pub url: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AuthConfig {
    pub jwt_secret: String,
    pub device_token_ttl: u64,
    pub user_token_ttl: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ControlConfig {
    pub claim_ttl: i64,
    pub claim_check_interval: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TelemetryConfig {
    pub history_ttl_hours: i64,
    pub prune_interval: u64,
    pub db_sample_rate: u32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LimitsConfig {
    pub max_devices_per_org: i64,
    pub max_users_per_org: i64,
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }

    pub fn from_env_overrides(mut self) -> Self {
        if let Ok(url) = std::env::var("DATABASE_URL") {
            self.database.url = url;
        }
        if let Ok(url) = std::env::var("REDIS_URL") {
            self.redis.url = url;
        }
        if let Ok(secret) = std::env::var("JWT_SECRET") {
            self.auth.jwt_secret = secret;
        }
        self
    }
}
