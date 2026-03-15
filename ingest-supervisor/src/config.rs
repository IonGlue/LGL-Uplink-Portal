use anyhow::Result;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub supervisor: SupervisorConfig,
    #[serde(default)]
    pub source_binary: String,
    #[serde(default)]
    pub dest_binary: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SupervisorConfig {
    /// Port for the local REST API (127.0.0.1 only)
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    /// Start of internal SRT port range assigned to source workers
    #[serde(default = "default_port_start")]
    pub internal_port_start: u16,
    /// End of internal SRT port range
    #[serde(default = "default_port_end")]
    pub internal_port_end: u16,
    /// How many times to restart a failed worker before giving up
    #[serde(default = "default_max_restarts")]
    pub max_restarts: u32,
    /// Seconds window for counting restarts (if max_restarts happen in this window, give up)
    #[serde(default = "default_restart_window")]
    pub restart_window_secs: u64,
}

fn default_api_port() -> u16 { 9000 }
fn default_port_start() -> u16 { 10000 }
fn default_port_end() -> u16 { 11000 }
fn default_max_restarts() -> u32 { 5 }
fn default_restart_window_secs() -> u64 { 60 }

// Make fn default_restart_window accessible
fn default_restart_window() -> u64 { default_restart_window_secs() }

impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let mut config: Self = toml::from_str(&content)?;

        // Default binary paths to current directory
        if config.source_binary.is_empty() {
            config.source_binary = "./ingest-source".to_string();
        }
        if config.dest_binary.is_empty() {
            config.dest_binary = "./ingest-dest".to_string();
        }

        // Env overrides
        if let Ok(v) = std::env::var("INGEST_SOURCE_BIN") {
            config.source_binary = v;
        }
        if let Ok(v) = std::env::var("INGEST_DEST_BIN") {
            config.dest_binary = v;
        }

        Ok(config)
    }
}
