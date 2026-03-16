use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use log::{error, info, warn};
use serde_json::json;
use tokio::process::Child;
use tokio::sync::RwLock;

use crate::config::Config;
use crate::port_pool::PortPool;
use crate::routing::{DestSlot, DestStatus, RoutingTable, SourceSlot, SourceStatus,
                     SyncGroup, SyncGroupStatus, RoutingSnapshot};

#[derive(Debug)]
pub struct WorkerHandle {
    pub id: String,
    pub kind: WorkerKind,
    pub process: Child,
    pub restart_count: u32,
    pub last_restart: Option<Instant>,
    pub error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorkerKind {
    Source,
    Dest,
    Sync,
}

pub struct Supervisor {
    pub config: Config,
    pub routing: Arc<RwLock<RoutingTable>>,
    pub workers: HashMap<String, WorkerHandle>,
    _port_pool: Arc<RwLock<PortPool>>,
}

impl Supervisor {
    pub fn new(
        config: Config,
        port_pool: Arc<RwLock<PortPool>>,
        routing: Arc<RwLock<RoutingTable>>,
    ) -> Self {
        Self {
            config,
            routing,
            workers: HashMap::new(),
            _port_pool: port_pool,
        }
    }

    /// Start a source worker process for the given source slot.
    pub async fn start_source(&mut self, source: &SourceSlot) -> Result<()> {
        let port = source.internal_port.ok_or_else(|| anyhow::anyhow!("source has no internal_port"))?;

        // Build worker config JSON
        let mut worker_config = source.config.clone();
        let obj = worker_config.as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("source config must be a JSON object"))?;
        obj.insert("id".to_string(), json!(source.id));
        obj.insert("source_type".to_string(), json!(source.source_type));
        obj.insert("internal_port".to_string(), json!(port));

        let config_str = serde_json::to_string(&worker_config)?;

        let config_path = format!("/tmp/ingest-source-{}.json", source.id);
        std::fs::write(&config_path, &config_str)?;

        info!("starting source worker: {} (type={})", source.id, source.source_type);

        let child = tokio::process::Command::new(&self.config.source_binary)
            .arg(&config_path)
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;

        let pid = child.id();

        self.workers.insert(source.id.clone(), WorkerHandle {
            id: source.id.clone(),
            kind: WorkerKind::Source,
            process: child,
            restart_count: 0,
            last_restart: None,
            error: false,
        });

        // Update source status and PID
        let mut routing = self.routing.write().await;
        if let Some(s) = routing.sources.get_mut(&source.id) {
            s.status = SourceStatus::Active;
            s.process_pid = pid;
        }

        Ok(())
    }

    /// Start a destination worker process.
    pub async fn start_dest(&mut self, dest: &DestSlot, source_internal_port: u16) -> Result<()> {
        let mut worker_config = dest.config.clone();
        let obj = worker_config.as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("dest config must be a JSON object"))?;
        obj.insert("id".to_string(), json!(dest.id));
        obj.insert("dest_type".to_string(), json!(dest.dest_type));
        obj.insert("source_internal_port".to_string(), json!(source_internal_port));

        let config_path = format!("/tmp/ingest-dest-{}.json", dest.id);
        std::fs::write(&config_path, serde_json::to_string(&worker_config)?)?;

        info!("starting dest worker: {} (type={})", dest.id, dest.dest_type);

        let child = tokio::process::Command::new(&self.config.dest_binary)
            .arg(&config_path)
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;

        let pid = child.id();

        self.workers.insert(dest.id.clone(), WorkerHandle {
            id: dest.id.clone(),
            kind: WorkerKind::Dest,
            process: child,
            restart_count: 0,
            last_restart: None,
            error: false,
        });

        let mut routing = self.routing.write().await;
        if let Some(d) = routing.dests.get_mut(&dest.id) {
            d.status = DestStatus::Active;
            d.process_pid = pid;
        }

        Ok(())
    }

    /// Spawn an `ingest-sync` worker for the given sync group.
    pub async fn start_sync_group(&mut self, group: &SyncGroup, routing: &RoutingSnapshot) -> Result<()> {
        let streams: Vec<serde_json::Value> = group.source_ids.iter().filter_map(|sid| {
            let source_port = routing.sources.get(sid)?.internal_port?;
            let output_port = group.aligned_ports.get(sid)?;
            Some(serde_json::json!({
                "source_id": sid,
                "source_port": source_port,
                "output_port": output_port,
            }))
        }).collect();

        let config = serde_json::json!({
            "id": group.id,
            "streams": streams,
            "target_delay_ms": group.target_delay_ms,
            "max_offset_ms": group.max_offset_ms,
        });

        let config_path = format!("/tmp/ingest-sync-{}.json", group.id);
        std::fs::write(&config_path, serde_json::to_string(&config)?)?;

        info!("starting sync worker: {} ({} streams, delay={}ms)",
            group.id, streams.len(), group.target_delay_ms);

        let child = tokio::process::Command::new(&self.config.sync_binary)
            .arg(&config_path)
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;

        self.workers.insert(group.id.clone(), WorkerHandle {
            id: group.id.clone(),
            kind: WorkerKind::Sync,
            process: child,
            restart_count: 0,
            last_restart: None,
            error: false,
        });

        Ok(())
    }

    /// Stop a worker by ID.
    pub async fn stop_worker(&mut self, id: &str) {
        if let Some(mut handle) = self.workers.remove(id) {
            info!("stopping worker: {id}");
            let _ = handle.process.kill().await;
        }
    }

    pub fn worker_count(&self) -> usize {
        self.workers.len()
    }
}

/// Main supervision loop.
///
/// Takes the `Arc` directly so it can acquire the write-lock **briefly**
/// per 2-second poll tick and release it between ticks and during
/// restart back-off sleeps.  This prevents the permanent lock-hold that
/// would deadlock every API handler.
pub async fn run_supervision_loop(supervisor: Arc<RwLock<Supervisor>>) -> Result<()> {
    let mut check_interval = tokio::time::interval(Duration::from_secs(2));

    loop {
        check_interval.tick().await;

        // --- brief lock: collect crashed worker IDs then release ---
        let crashed: Vec<(String, WorkerKind)> = {
            let mut sup = supervisor.write().await;
            let mut out = Vec::new();
            for (id, handle) in &mut sup.workers {
                match handle.process.try_wait() {
                    Ok(Some(status)) => {
                        if !handle.error {
                            warn!("worker {id} exited with status: {status}");
                            out.push((id.clone(), handle.kind.clone()));
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        warn!("worker {id} wait error: {e}");
                    }
                }
            }
            out
        }; // write lock released here

        for (id, kind) in crashed {
            do_restart(supervisor.clone(), &id, &kind).await;
        }
    }
}

/// Handles crash detection, back-off sleep (without holding any lock),
/// and worker restart.
async fn do_restart(supervisor: Arc<RwLock<Supervisor>>, id: &str, kind: &WorkerKind) {
    // Read config and restart state without holding the lock over the sleep.
    let (max_restarts, restart_window, restart_count, last_restart) = {
        let sup = supervisor.read().await;
        let h = match sup.workers.get(id) {
            Some(h) => h,
            None => return,
        };
        let max = sup.config.supervisor.max_restarts;
        let window = Duration::from_secs(sup.config.supervisor.restart_window_secs);
        (max, window, h.restart_count, h.last_restart)
    }; // read lock released

    // Reset counter if last crash was outside the window.
    let effective_count = match last_restart {
        Some(t) if t.elapsed() > restart_window => 0,
        _ => restart_count,
    };

    if effective_count >= max_restarts {
        error!("worker {id} exceeded max restarts ({max_restarts}), giving up");
        let mut sup = supervisor.write().await;
        if let Some(h) = sup.workers.get_mut(id) {
            h.error = true;
        }
        let mut routing = sup.routing.write().await;
        match kind {
            WorkerKind::Source => {
                if let Some(s) = routing.sources.get_mut(id) { s.status = SourceStatus::Error; }
            }
            WorkerKind::Dest => {
                if let Some(d) = routing.dests.get_mut(id) { d.status = DestStatus::Error; }
            }
            WorkerKind::Sync => {
                if let Some(g) = routing.sync_groups.get_mut(id) { g.status = SyncGroupStatus::Error; }
            }
        }
        return;
    }

    // Record the restart attempt before sleeping.
    {
        let mut sup = supervisor.write().await;
        if let Some(h) = sup.workers.get_mut(id) {
            h.restart_count = effective_count + 1;
            h.last_restart  = Some(Instant::now());
        }
    } // write lock released

    // Exponential back-off: 1 s, 2 s, 4 s, 8 s, 16 s — NO lock held.
    let delay = Duration::from_secs(1 << effective_count.min(4));
    info!("restarting worker {id} (attempt {}) after {}s", effective_count + 1, delay.as_secs());
    tokio::time::sleep(delay).await;

    // Re-read routing state and restart the worker.
    let mut sup = supervisor.write().await;
    match kind {
        WorkerKind::Source => {
            let source = sup.routing.read().await.sources.get(id).cloned();
            if let Some(source) = source {
                if let Err(e) = sup.start_source(&source).await {
                    error!("failed to restart source {id}: {e}");
                }
            }
        }
        WorkerKind::Dest => {
            let (dest, source_port) = {
                let routing = sup.routing.read().await;
                let dest = routing.dests.get(id).cloned();
                let source_port = routing.source_for_dest(id)
                    .and_then(|sid| routing.effective_port_for_source(&sid));
                (dest, source_port)
            };
            if let (Some(dest), Some(port)) = (dest, source_port) {
                if let Err(e) = sup.start_dest(&dest, port).await {
                    error!("failed to restart dest {id}: {e}");
                }
            } else {
                warn!("cannot restart dest {id}: source not found or has no port");
            }
        }
        WorkerKind::Sync => {
            let (group, snapshot) = {
                let routing = sup.routing.read().await;
                let group = routing.sync_groups.get(id).cloned();
                let snapshot = routing.clone_for_sync();
                (group, snapshot)
            };
            if let Some(group) = group {
                match sup.start_sync_group(&group, &snapshot).await {
                    Ok(_) => {
                        let mut routing = sup.routing.write().await;
                        if let Some(g) = routing.sync_groups.get_mut(id) {
                            g.status = SyncGroupStatus::Active;
                        }
                    }
                    Err(e) => error!("failed to restart sync group {id}: {e}"),
                }
            }
        }
    }
    // supervisor write lock released here
}
