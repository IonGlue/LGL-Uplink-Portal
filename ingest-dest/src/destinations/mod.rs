pub mod rtmp;
pub mod srt_push;
pub mod hls;
pub mod recorder;

use anyhow::Result;
use gstreamer::prelude::*;
use log::info;

/// Common pipeline loop: poll bus for EOS/error, handle SIGINT/SIGTERM.
pub async fn run_pipeline_loop(id: &str, pipeline: &gstreamer::Pipeline, bus: &gstreamer::Bus) -> Result<()> {
    let mut sigterm = tokio::signal::unix::signal(
        tokio::signal::unix::SignalKind::terminate()
    )?;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("[{id}] SIGINT — stopping");
                break;
            }
            _ = sigterm.recv() => {
                info!("[{id}] SIGTERM — stopping");
                break;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                for msg in bus.iter() {
                    use gstreamer::MessageView;
                    match msg.view() {
                        MessageView::Eos(..) => {
                            info!("[{id}] EOS");
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
