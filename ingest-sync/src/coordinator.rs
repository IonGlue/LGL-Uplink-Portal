//! Multi-stream sync coordinator.
//!
//! The coordinator runs a pair of GStreamer pipelines per stream:
//!
//!   Input:  srtsrc (caller → source internal port)
//!             → tsparse (re-sync + keep valid TS packets)
//!             → appsink (pull raw MPEG-TS into Rust)
//!
//!   Output: appsrc (push aligned MPEG-TS from Rust)
//!             → tsparse
//!             → srtsink (listener on output_port — destinations connect here)
//!
//! A Tokio task loops over all streams, pulls data from their appsinks,
//! pushes it through StreamBuffer (which applies the calculated hold delay),
//! then pushes released chunks to the corresponding appsrc.
//!
//! Hold calculation (re-run every REBALANCE_INTERVAL):
//!   reference_latency = max(stream.latency_ns) over all streams with valid estimates
//!   hold[i] = target_delay + (reference_latency - latency[i])
//!
//! This ensures the slowest stream gets `target_delay` of extra buffer while
//! faster streams are held longer so they emerge in step.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use log::{debug, info, warn};
use tokio::sync::Mutex;
use tokio::time;

use crate::config::SyncConfig;
use crate::stream::StreamBuffer;

/// How often to recompute per-stream hold times (ms).
const REBALANCE_MS: u64 = 500;

/// How often to call `refresh_epoch` on all stream buffers (ms).
const EPOCH_REFRESH_MS: u64 = 60_000;

/// Maximum bytes allowed in a single stream's buffer before we start dropping
/// the oldest chunks (prevents unbounded memory growth on stalled streams).
const MAX_BUFFER_BYTES: usize = 64 * 1024 * 1024; // 64 MiB

/// State for a single stream managed by the coordinator.
struct StreamState {
    id: String,
    appsink: gst_app::AppSink,
    appsrc: gst_app::AppSrc,
    _input_pipeline: gst::Pipeline,
    _output_pipeline: gst::Pipeline,
    buffer: StreamBuffer,
}

pub struct Coordinator {
    config: SyncConfig,
    streams: Vec<StreamState>,
}

impl Coordinator {
    /// Build all GStreamer pipelines and return a ready-to-run coordinator.
    pub fn build(config: SyncConfig) -> Result<Self> {
        gst::init().context("GStreamer init failed")?;

        let mut streams = Vec::with_capacity(config.streams.len());

        for sc in &config.streams {
            info!(
                "[{}] sync stream: SRT :{} → buffer → SRT listener :{}",
                sc.source_id, sc.source_port, sc.output_port
            );

            // ── Input pipeline ────────────────────────────────────────────
            let input_desc = format!(
                "srtsrc name=srt_in uri=\"srt://127.0.0.1:{}?mode=caller&latency=200\" ! \
                 tsparse ! \
                 appsink name=sink emit-signals=false max-buffers=0 drop=false sync=false",
                sc.source_port
            );
            let input_pipeline = gst::parse::launch(&input_desc)
                .with_context(|| format!("parse input pipeline for {}", sc.source_id))?
                .downcast::<gst::Pipeline>()
                .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

            let appsink = input_pipeline
                .by_name("sink")
                .context("no appsink element")?
                .downcast::<gst_app::AppSink>()
                .map_err(|_| anyhow::anyhow!("element is not AppSink"))?;

            // ── Output pipeline ───────────────────────────────────────────
            let output_desc = format!(
                "appsrc name=src format=bytes is-live=true ! \
                 tsparse ! \
                 srtsink name=srt_out uri=\"srt://0.0.0.0:{}?mode=listener&latency=200\" \
                   wait-for-connection=false",
                sc.output_port
            );
            let output_pipeline = gst::parse::launch(&output_desc)
                .with_context(|| format!("parse output pipeline for {}", sc.source_id))?
                .downcast::<gst::Pipeline>()
                .map_err(|_| anyhow::anyhow!("not a pipeline"))?;

            let appsrc = output_pipeline
                .by_name("src")
                .context("no appsrc element")?
                .downcast::<gst_app::AppSrc>()
                .map_err(|_| anyhow::anyhow!("element is not AppSrc"))?;

            // Start pipelines
            input_pipeline
                .set_state(gst::State::Playing)
                .with_context(|| format!("set input pipeline Playing for {}", sc.source_id))?;
            output_pipeline
                .set_state(gst::State::Playing)
                .with_context(|| format!("set output pipeline Playing for {}", sc.source_id))?;

            streams.push(StreamState {
                id: sc.source_id.clone(),
                appsink,
                appsrc,
                _input_pipeline: input_pipeline,
                _output_pipeline: output_pipeline,
                buffer: StreamBuffer::new(&sc.source_id),
            });
        }

        Ok(Self { config, streams })
    }

    /// Run the coordinator until a shutdown signal is received.
    pub async fn run(self) -> Result<()> {
        let config = self.config.clone();
        let target_delay = Duration::from_millis(config.target_delay_ms as u64);
        let max_offset = Duration::from_millis(config.max_offset_ms as u64);

        let state = Arc::new(Mutex::new(self.streams));

        let state_pull = state.clone();
        let state_rebalance = state.clone();
        let state_epoch = state.clone();

        // ── Task: pull data from appsinks ─────────────────────────────────
        // Runs tightly (no sleep) so latency through the buffer is minimised.
        let pull_task = tokio::spawn(async move {
            let poll_interval = Duration::from_millis(1);
            loop {
                {
                    let mut streams = state_pull.lock().await;
                    for s in streams.iter_mut() {
                        // Pull all available samples from the appsink.
                        while let Some(sample) = s.appsink.try_pull_sample(gst::ClockTime::ZERO) {
                            if let Some(buf) = sample.buffer() {
                                if let Ok(map) = buf.map_readable() {
                                    let data = Bytes::copy_from_slice(map.as_slice());
                                    // Drop oldest chunks if buffer is full.
                                    if s.buffer.buffered_bytes() > MAX_BUFFER_BYTES {
                                        warn!("[{}] buffer overflow — dropping oldest data", s.id);
                                        s.buffer.clear();
                                    }
                                    s.buffer.push(data);
                                }
                            }
                        }

                        // Release chunks whose hold deadline has passed.
                        for chunk in s.buffer.drain_ready() {
                            push_to_appsrc(&s.appsrc, chunk, &s.id);
                        }
                    }
                }
                time::sleep(poll_interval).await;
            }
        });

        // ── Task: rebalance hold times ────────────────────────────────────
        let rebalance_task = tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_millis(REBALANCE_MS));
            loop {
                interval.tick().await;
                let mut streams = state_rebalance.lock().await;
                rebalance(&mut streams, target_delay, max_offset);
            }
        });

        // ── Task: refresh epoch mapping ───────────────────────────────────
        let epoch_task = tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_millis(EPOCH_REFRESH_MS));
            loop {
                interval.tick().await;
                let mut streams = state_epoch.lock().await;
                for s in streams.iter_mut() {
                    s.buffer.refresh_epoch();
                }
            }
        });

        // Wait for shutdown signal.
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("[{}] shutting down (SIGINT)", config.id);
            }
            _ = async {
                let mut sig = tokio::signal::unix::signal(
                    tokio::signal::unix::SignalKind::terminate()
                ).expect("SIGTERM handler");
                sig.recv().await
            } => {
                info!("[{}] shutting down (SIGTERM)", config.id);
            }
        }

        pull_task.abort();
        rebalance_task.abort();
        epoch_task.abort();

        Ok(())
    }
}

/// Recompute hold durations for all streams.
///
/// Algorithm:
///   1. Find the maximum latency estimate across all streams (= slowest stream).
///   2. Each stream's hold = target_delay + (max_latency - stream_latency).
///      This delays faster streams to match the slowest, then adds target_delay
///      as a minimum cushion so the slowest stream also has a buffer.
fn rebalance(streams: &mut Vec<StreamState>, target_delay: Duration, max_offset: Duration) {
    // Collect valid latency estimates (ns).
    let latencies: Vec<(usize, i64)> = streams
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.buffer.latency.latency_ns.map(|l| (i, l)))
        .collect();

    if latencies.is_empty() {
        // No PCR data yet — every stream uses target_delay as a flat buffer.
        for s in streams.iter_mut() {
            s.buffer.hold = target_delay;
        }
        return;
    }

    let max_latency_ns = latencies.iter().map(|(_, l)| *l).max().unwrap();
    let max_offset_ns = max_offset.as_nanos() as i64;

    for (i, s) in streams.iter_mut().enumerate() {
        let latency_ns = match s.buffer.latency.latency_ns {
            Some(l) => l,
            None => {
                // No estimate yet — use target_delay.
                s.buffer.hold = target_delay;
                continue;
            }
        };

        let offset_ns = max_latency_ns - latency_ns;

        if offset_ns > max_offset_ns {
            // Stream is way ahead — may have reconnected with a new clock.
            // Reset buffer and treat as if latency = max_latency.
            warn!(
                "[{}] stream {} offset {}ms exceeds max_offset {}ms — resetting",
                "coordinator",
                i,
                offset_ns / 1_000_000,
                max_offset.as_millis(),
            );
            s.buffer.clear();
            s.buffer.latency.latency_ns = None;
            s.buffer.hold = target_delay;
            continue;
        }

        let hold_ns = target_delay.as_nanos() as i64 + offset_ns;
        let hold_ns = hold_ns.max(0) as u64;
        s.buffer.hold = Duration::from_nanos(hold_ns);

        debug!(
            "[{}] hold={:.0}ms  latency={:.0}ms  offset={:.0}ms",
            s.id,
            s.buffer.hold.as_secs_f64() * 1000.0,
            latency_ns as f64 / 1_000_000.0,
            offset_ns as f64 / 1_000_000.0,
        );
    }
}

/// Push a raw MPEG-TS chunk into the GStreamer `appsrc`.
fn push_to_appsrc(appsrc: &gst_app::AppSrc, data: Bytes, id: &str) {
    let Ok(mut buf) = gst::Buffer::with_size(data.len()) else {
        warn!("[{id}] failed to allocate GStreamer buffer ({} bytes)", data.len());
        return;
    };
    {
        let Some(buf_ref) = buf.get_mut() else {
            warn!("[{id}] buffer has multiple references, cannot write");
            return;
        };
        let Ok(mut map) = buf_ref.map_writable() else {
            warn!("[{id}] failed to map buffer as writable");
            return;
        };
        map.as_mut_slice().copy_from_slice(&data);
    }
    if let Err(e) = appsrc.push_buffer(buf) {
        debug!("[{id}] appsrc push error: {e:?}");
    }
}
