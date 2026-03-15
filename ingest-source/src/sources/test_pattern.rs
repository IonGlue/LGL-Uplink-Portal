//! Test pattern source: videotestsrc → x264enc → MPEG-TS → SRT listener.
//!
//! Generates a synthetic video signal (SMPTE bars, etc.) and exposes it
//! as an SRT listener on `internal_port` for destination workers to connect to.

use anyhow::{Context, Result};
use gstreamer::prelude::*;
use log::info;

use crate::TestPatternConfig;

pub async fn run(id: String, internal_port: u16, config: TestPatternConfig) -> Result<()> {
    info!(
        "[{id}] test_pattern source: pattern={} {}x{}@{}fps {}kbps → SRT listener :{internal_port}",
        config.pattern, config.width, config.height, config.framerate, config.bitrate_kbps
    );

    let uri = format!(
        "srt://0.0.0.0:{internal_port}?mode=listener&latency={}",
        config.srt_latency_ms
    );

    let pipeline_str = format!(
        "videotestsrc pattern={pattern} is-live=true ! \
         video/x-raw,width={w},height={h},framerate={fps}/1 ! \
         videoconvert ! \
         x264enc name=encoder tune=zerolatency speed-preset=superfast key-int-max={fps} bitrate={bps} ! \
         video/x-h264,profile=high ! \
         mpegtsmux ! \
         srtsink name=srt_sink uri=\"{uri}\" wait-for-connection=false",
        pattern = config.pattern,
        w = config.width,
        h = config.height,
        fps = config.framerate,
        bps = config.bitrate_kbps,
        uri = uri,
    );

    info!("[{id}] pipeline: {pipeline_str}");

    let pipeline = gstreamer::parse::launch(&pipeline_str)
        .context("failed to parse GStreamer pipeline")?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

    let bus = pipeline.bus().context("no pipeline bus")?;

    pipeline
        .set_state(gstreamer::State::Playing)
        .context("failed to set pipeline to Playing")?;
    info!("[{id}] test_pattern pipeline playing");

    run_pipeline_loop(&id, &pipeline, &bus).await
}

pub async fn run_pipeline_loop(
    id: &str,
    pipeline: &gstreamer::Pipeline,
    bus: &gstreamer::Bus,
) -> Result<()> {
    let mut sigterm = tokio::signal::unix::signal(
        tokio::signal::unix::SignalKind::terminate()
    )?;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("[{id}] SIGINT — stopping pipeline");
                break;
            }
            _ = sigterm.recv() => {
                info!("[{id}] SIGTERM — stopping pipeline");
                break;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                for msg in bus.iter() {
                    use gstreamer::MessageView;
                    match msg.view() {
                        MessageView::Eos(..) => {
                            info!("[{id}] EOS received");
                            pipeline.set_state(gstreamer::State::Null).ok();
                            return Ok(());
                        }
                        MessageView::Error(e) => {
                            let _ = pipeline.set_state(gstreamer::State::Null);
                            anyhow::bail!("[{id}] pipeline error: {}", e.error());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    pipeline.set_state(gstreamer::State::Null).ok();
    Ok(())
}
