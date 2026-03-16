//! RTMP destination: receives SRT from source worker, pushes to RTMP ingest endpoint.
//!
//! Pipeline:
//!   srtsrc (caller) → tsdemux [dynamic pads] → queue → h264parse
//!     → video/x-h264,stream-format=avc,alignment=au
//!     → flvmux (video request pad) → rtmpsink
//!
//! `tsdemux` emits source pads dynamically when the stream arrives, so we
//! cannot use a `gst_parse::launch` string for the full pipeline.  Instead
//! we build the static elements with the parse API and connect the tsdemux
//! output pad via the `pad-added` signal once it appears.

use anyhow::{Context, Result};
use gstreamer as gst;
use gstreamer::prelude::*;
use log::{info, warn};

use crate::RtmpConfig;
use super::run_pipeline_loop;

pub async fn run(id: String, source_port: u16, latency_ms: u32, config: RtmpConfig) -> Result<()> {
    info!("[{id}] rtmp dest: SRT :{source_port} → RTMP {}", config.url);

    let srt_uri = format!("srt://127.0.0.1:{source_port}?mode=caller&latency={latency_ms}");

    let pipeline = gst::Pipeline::new();

    // Build elements
    let srtsrc = gst::ElementFactory::make("srtsrc")
        .property("uri", &srt_uri)
        .build()
        .context("srtsrc")?;

    let tsdemux = gst::ElementFactory::make("tsdemux")
        .build()
        .context("tsdemux")?;

    let queue = gst::ElementFactory::make("queue")
        .build()
        .context("queue")?;

    let h264parse = gst::ElementFactory::make("h264parse")
        .build()
        .context("h264parse")?;

    let capsfilter = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            &gst::Caps::builder("video/x-h264")
                .field("stream-format", "avc")
                .field("alignment", "au")
                .build(),
        )
        .build()
        .context("capsfilter")?;

    let flvmux = gst::ElementFactory::make("flvmux")
        .property("streamable", true)
        .build()
        .context("flvmux")?;

    let rtmpsink = gst::ElementFactory::make("rtmpsink")
        .property("location", &config.url)
        .property("sync", false)
        .build()
        .context("rtmpsink")?;

    pipeline
        .add_many([&srtsrc, &tsdemux, &queue, &h264parse, &capsfilter, &flvmux, &rtmpsink])
        .context("add elements")?;

    // Static links (no dynamic pads involved)
    srtsrc.link(&tsdemux).context("srtsrc→tsdemux")?;
    gst::Element::link_many([&queue, &h264parse, &capsfilter]).context("queue chain")?;

    // capsfilter → flvmux video request pad
    let flvmux_video = flvmux
        .request_pad_simple("video")
        .context("flvmux has no video request pad")?;
    capsfilter
        .static_pad("src")
        .context("capsfilter src pad")?
        .link(&flvmux_video)
        .context("capsfilter→flvmux")?;

    flvmux.link(&rtmpsink).context("flvmux→rtmpsink")?;

    // Connect tsdemux's dynamic video pad to our queue when it appears.
    // tsdemux emits one pad per elementary stream; we take the first video one.
    let queue_sink = queue.static_pad("sink").context("queue sink pad")?;
    tsdemux.connect_pad_added(move |_elem, src_pad| {
        // Only link if this is a video pad and the queue sink is not yet linked.
        let caps = src_pad.current_caps().unwrap_or_else(|| src_pad.query_caps(None));
        let is_video = caps
            .structure(0)
            .map(|s| s.name().starts_with("video/"))
            .unwrap_or(false);

        if !is_video || queue_sink.is_linked() {
            return;
        }

        if let Err(e) = src_pad.link(&queue_sink) {
            warn!("tsdemux→queue pad link failed: {e:?}");
        }
    });

    let bus = pipeline.bus().context("no bus")?;
    pipeline
        .set_state(gst::State::Playing)
        .context("set Playing")?;
    info!("[{id}] rtmp pipeline playing");

    run_pipeline_loop(&id, &pipeline, &bus).await
}
