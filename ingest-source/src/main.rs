use anyhow::{Context, Result};
use serde::Deserialize;
use std::io::Read;

mod sources;

#[derive(Debug, Deserialize)]
struct SourceConfig {
    id: String,
    source_type: String,
    internal_port: u16,
    encoder: Option<EncoderConfig>,
    test_pattern: Option<TestPatternConfig>,
    srt_listen: Option<SrtListenConfig>,
    srt_pull: Option<SrtPullConfig>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct EncoderConfig {
    pub srtla_listen_port: u16,
    #[serde(default = "default_latency")]
    pub srt_latency_ms: u32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TestPatternConfig {
    #[serde(default = "default_pattern")]
    pub pattern: String,
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
    #[serde(default = "default_framerate")]
    pub framerate: u32,
    #[serde(default = "default_bitrate")]
    pub bitrate_kbps: u32,
    #[serde(default = "default_latency")]
    pub srt_latency_ms: u32,
}

impl Default for TestPatternConfig {
    fn default() -> Self {
        Self {
            pattern: default_pattern(),
            width: default_width(),
            height: default_height(),
            framerate: default_framerate(),
            bitrate_kbps: default_bitrate(),
            srt_latency_ms: default_latency(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct SrtListenConfig {
    pub port: u16,
    #[serde(default = "default_latency")]
    pub latency_ms: u32,
    pub passphrase: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SrtPullConfig {
    pub host: String,
    pub port: u16,
    #[serde(default = "default_latency")]
    pub latency_ms: u32,
    pub passphrase: Option<String>,
}

fn default_pattern() -> String { "smpte".to_string() }
fn default_width() -> u32 { 1920 }
fn default_height() -> u32 { 1080 }
fn default_framerate() -> u32 { 30 }
fn default_bitrate() -> u32 { 4000 }
fn default_latency() -> u32 { 200 }

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    let config: SourceConfig = {
        let input = if let Some(path) = std::env::args().nth(1) {
            std::fs::read_to_string(&path)
                .with_context(|| format!("failed to read config file: {path}"))?
        } else {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s
        };
        serde_json::from_str(&input).context("failed to parse source config")?
    };

    log::info!(
        "starting source worker: id={} type={} internal_port={}",
        config.id, config.source_type, config.internal_port
    );

    gstreamer::init().context("failed to init GStreamer")?;

    match config.source_type.as_str() {
        "encoder" => {
            let enc = config.encoder.context("encoder config missing")?;
            sources::encoder::run(config.id, config.internal_port, enc).await
        }
        "test_pattern" => {
            let tp = config.test_pattern.unwrap_or_default();
            sources::test_pattern::run(config.id, config.internal_port, tp).await
        }
        "srt_listen" => {
            let sl = config.srt_listen.context("srt_listen config missing")?;
            sources::srt_listen::run(config.id, config.internal_port, sl).await
        }
        "srt_pull" => {
            let sp = config.srt_pull.context("srt_pull config missing")?;
            sources::srt_pull::run(config.id, config.internal_port, sp).await
        }
        other => anyhow::bail!("unknown source_type: {other}"),
    }
}
