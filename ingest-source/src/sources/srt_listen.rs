//! SRT listen source: accepts an incoming SRT stream and re-exposes it on the internal port.

use anyhow::{Context, Result};
use gstreamer::prelude::*;
use log::info;

use crate::SrtListenConfig;

pub async fn run(id: String, internal_port: u16, config: SrtListenConfig) -> Result<()> {
    info!(
        "[{id}] srt_listen source: listening on :{} → re-exposing on :{internal_port}",
        config.port
    );

    let mut input_uri = format!(
        "srt://0.0.0.0:{}?mode=listener&latency={}",
        config.port, config.latency_ms
    );
    if let Some(ref pass) = config.passphrase {
        input_uri.push_str(&format!("&passphrase={pass}"));
    }
    let output_uri = format!(
        "srt://0.0.0.0:{internal_port}?mode=listener&latency={}",
        config.latency_ms
    );

    let pipeline_str = format!(
        "srtsrc name=srt_in uri=\"{input_uri}\" ! \
         tsparse ! \
         srtsink name=srt_out uri=\"{output_uri}\" wait-for-connection=false",
    );

    info!("[{id}] pipeline: {pipeline_str}");

    let pipeline = gstreamer::parse::launch(&pipeline_str)
        .context("failed to parse GStreamer pipeline")?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

    let bus = pipeline.bus().context("no pipeline bus")?;
    pipeline
        .set_state(gstreamer::State::Playing)
        .context("failed to set Playing")?;
    info!("[{id}] srt_listen pipeline playing");

    crate::sources::test_pattern::run_pipeline_loop(&id, &pipeline, &bus).await
}
