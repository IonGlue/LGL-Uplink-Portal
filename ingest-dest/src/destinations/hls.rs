//! HLS destination: writes HLS segments and playlist to disk.

use anyhow::{Context, Result};
use gstreamer::prelude::*;
use log::info;

use crate::HlsConfig;
use super::run_pipeline_loop;

pub async fn run(id: String, source_port: u16, latency_ms: u32, config: HlsConfig) -> Result<()> {
    info!("[{id}] hls dest: SRT :{source_port} → HLS {}", config.location);

    std::fs::create_dir_all(&config.location)
        .with_context(|| format!("failed to create HLS dir: {}", config.location))?;

    let srt_uri = format!("srt://127.0.0.1:{source_port}?mode=caller&latency={latency_ms}");
    let segment_pattern = format!("{}/segment%05d.ts", config.location);

    let pipeline_str = format!(
        "srtsrc name=srt_in uri=\"{srt_uri}\" ! \
         tsdemux name=demux ! \
         queue ! \
         h264parse ! \
         hlssink2 name=hls_sink \
           location=\"{seg}\" \
           playlist-location=\"{playlist}\" \
           target-duration={dur} \
           max-files=10",
        seg = segment_pattern,
        playlist = config.playlist_location,
        dur = config.target_duration,
    );

    info!("[{id}] pipeline: {pipeline_str}");

    let pipeline = gstreamer::parse::launch(&pipeline_str)
        .context("failed to parse pipeline")?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

    let bus = pipeline.bus().context("no bus")?;
    pipeline.set_state(gstreamer::State::Playing).context("set Playing failed")?;
    info!("[{id}] hls pipeline playing");

    run_pipeline_loop(&id, &pipeline, &bus).await
}
