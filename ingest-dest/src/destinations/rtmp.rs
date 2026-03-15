//! RTMP destination: receives SRT from source worker, pushes to RTMP ingest endpoint.

use anyhow::{Context, Result};
use gstreamer::prelude::*;
use log::info;

use crate::RtmpConfig;
use super::run_pipeline_loop;

pub async fn run(id: String, source_port: u16, latency_ms: u32, config: RtmpConfig) -> Result<()> {
    info!("[{id}] rtmp dest: SRT :{source_port} → RTMP {}", config.url);

    let srt_uri = format!("srt://127.0.0.1:{source_port}?mode=caller&latency={latency_ms}");

    // Receive MPEG-TS over SRT, demux H.264, mux to FLV, push RTMP.
    // tsdemux uses dynamic pads — we use decodebin for automatic codec handling.
    let pipeline_str = format!(
        "srtsrc name=srt_in uri=\"{srt_uri}\" ! \
         tsdemux name=demux ! \
         queue ! \
         h264parse ! \
         video/x-h264,stream-format=avc,alignment=au ! \
         flvmux streamable=true name=mux ! \
         rtmpsink name=rtmp_out location=\"{url}\" sync=false",
        url = config.url,
    );

    info!("[{id}] pipeline: {pipeline_str}");

    let pipeline = gstreamer::parse::launch(&pipeline_str)
        .context("failed to parse pipeline")?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

    let bus = pipeline.bus().context("no bus")?;
    pipeline.set_state(gstreamer::State::Playing).context("set Playing failed")?;
    info!("[{id}] rtmp pipeline playing");

    run_pipeline_loop(&id, &pipeline, &bus).await
}
