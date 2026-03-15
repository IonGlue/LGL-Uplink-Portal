use anyhow::{Context, Result};
use serde::Deserialize;
use std::io::Read;

mod destinations;

#[derive(Debug, Deserialize)]
struct DestConfig {
    id: String,
    dest_type: String,
    source_internal_port: u16,
    #[serde(default = "default_latency")]
    srt_latency_ms: u32,
    rtmp: Option<RtmpConfig>,
    srt_push: Option<SrtPushConfig>,
    hls: Option<HlsConfig>,
    recorder: Option<RecorderConfig>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RtmpConfig {
    pub url: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SrtPushConfig {
    pub host: String,
    pub port: u16,
    #[serde(default = "default_latency")]
    pub latency_ms: u32,
    pub passphrase: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct HlsConfig {
    pub location: String,
    pub playlist_location: String,
    #[serde(default = "default_hls_duration")]
    pub target_duration: u32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RecorderConfig {
    pub path: String,
    #[serde(default = "default_format")]
    pub format: String,
}

fn default_latency() -> u32 { 200 }
fn default_hls_duration() -> u32 { 2 }
fn default_format() -> String { "mpegts".to_string() }

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    let config: DestConfig = {
        let input = if let Some(path) = std::env::args().nth(1) {
            std::fs::read_to_string(&path)
                .with_context(|| format!("failed to read config: {path}"))?
        } else {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            s
        };
        serde_json::from_str(&input).context("failed to parse dest config")?
    };

    log::info!(
        "starting dest worker: id={} type={} source_port={}",
        config.id, config.dest_type, config.source_internal_port
    );

    gstreamer::init().context("failed to init GStreamer")?;

    match config.dest_type.as_str() {
        "rtmp" => {
            let rc = config.rtmp.context("rtmp config missing")?;
            destinations::rtmp::run(config.id, config.source_internal_port, config.srt_latency_ms, rc).await
        }
        "srt_push" => {
            let sc = config.srt_push.context("srt_push config missing")?;
            destinations::srt_push::run(config.id, config.source_internal_port, config.srt_latency_ms, sc).await
        }
        "hls" => {
            let hc = config.hls.context("hls config missing")?;
            destinations::hls::run(config.id, config.source_internal_port, config.srt_latency_ms, hc).await
        }
        "recorder" => {
            let rc = config.recorder.context("recorder config missing")?;
            destinations::recorder::run(config.id, config.source_internal_port, config.srt_latency_ms, rc).await
        }
        other => anyhow::bail!("unknown dest_type: {other}"),
    }
}
