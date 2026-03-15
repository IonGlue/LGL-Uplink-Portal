//! SRT push destination: re-streams to another SRT endpoint (e.g. another LGL Ingest instance).

use anyhow::{Context, Result};
use gstreamer::prelude::*;
use log::info;

use crate::SrtPushConfig;
use super::run_pipeline_loop;

pub async fn run(id: String, source_port: u16, latency_ms: u32, config: SrtPushConfig) -> Result<()> {
    info!("[{id}] srt_push dest: SRT :{source_port} → {}:{}", config.host, config.port);

    let srt_in_uri = format!("srt://127.0.0.1:{source_port}?mode=caller&latency={latency_ms}");
    let mut srt_out_uri = format!(
        "srt://{}:{}?mode=caller&latency={}",
        config.host, config.port, config.latency_ms
    );
    if let Some(ref pass) = config.passphrase {
        srt_out_uri.push_str(&format!("&passphrase={pass}"));
    }

    // Pure MPEG-TS passthrough: SRT → tsparse (validates/buffers) → SRT
    let pipeline_str = format!(
        "srtsrc name=srt_in uri=\"{srt_in_uri}\" ! \
         tsparse ! \
         srtsink name=srt_out uri=\"{srt_out_uri}\"",
    );

    info!("[{id}] pipeline: {pipeline_str}");

    let pipeline = gstreamer::parse::launch(&pipeline_str)
        .context("failed to parse pipeline")?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

    let bus = pipeline.bus().context("no bus")?;
    pipeline.set_state(gstreamer::State::Playing).context("set Playing failed")?;
    info!("[{id}] srt_push pipeline playing");

    run_pipeline_loop(&id, &pipeline, &bus).await
}
