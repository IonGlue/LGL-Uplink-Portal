//! Recording destination: saves SRT stream to a timestamped MPEG-TS file.

use anyhow::{Context, Result};
use gstreamer::prelude::*;
use log::info;

use crate::RecorderConfig;
use super::run_pipeline_loop;

pub async fn run(id: String, source_port: u16, latency_ms: u32, config: RecorderConfig) -> Result<()> {
    info!("[{id}] recorder dest: SRT :{source_port} → {}", config.path);

    std::fs::create_dir_all(&config.path)
        .with_context(|| format!("failed to create recording directory: {}", config.path))?;

    let srt_uri = format!("srt://127.0.0.1:{source_port}?mode=caller&latency={latency_ms}");

    let now = chrono::Utc::now();
    let timestamp = now.format("%Y%m%d-%H%M%S");
    let file_path = format!("{}/{}-{}.ts", config.path, id, timestamp);

    info!("[{id}] recording to: {file_path}");

    // Raw MPEG-TS passthrough to file — no decode needed, minimal CPU usage.
    let pipeline_str = format!(
        "srtsrc name=srt_in uri=\"{srt_uri}\" ! \
         filesink name=file_out location=\"{file_path}\" sync=false",
    );

    info!("[{id}] pipeline: {pipeline_str}");

    let pipeline = gstreamer::parse::launch(&pipeline_str)
        .context("failed to parse pipeline")?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

    let bus = pipeline.bus().context("no bus")?;
    pipeline.set_state(gstreamer::State::Playing).context("set Playing failed")?;
    info!("[{id}] recorder pipeline playing");

    run_pipeline_loop(&id, &pipeline, &bus).await
}
