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
use crate::routing::{DestSlot, DestStatus, RoutingTable, SourceSlot, SourceStatus};

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
}

pub struct Supervisor {
    config: Config,
    port_pool: Arc<RwLock<PortPool>>,
    routing: Arc<RwLock<RoutingTable>>,
    workers: HashMap<String, WorkerHandle>,
}

impl Supervisor {
    pub fn new(
        config: Config,
        port_pool: Arc<RwLock<PortPool>>,
        routing: Arc<RwLock<RoutingTable>>,
    ) -> Self {
        Self {
            config,
            port_pool,
            routing,
            workers: HashMap::new(),
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

        info!("starting source worker: {} (type={})", source.id, source.source_type);

        let child = tokio::process::Command::new(&self.config.source_binary)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;

        // Write config to stdin
        // Note: we pass config via a temp file to avoid stdin complexity with async
        let config_path = format!("/tmp/ingest-source-{}.json", source.id);
        std::fs::write(&config_path, &config_str)?;

        // Re-spawn with config file arg
        let child = tokio::process::Command::new(&self.config.source_binary)
            .arg(&config_path)
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;

        let handle = WorkerHandle {
            id: source.id.clone(),
            kind: WorkerKind::Source,
            process: child,
            restart_count: 0,
            last_restart: None,
            error: false,
        };

        self.workers.insert(source.id.clone(), handle);

        // Update source status
        let mut routing = self.routing.write().await;
        if let Some(s) = routing.sources.get_mut(&source.id) {
            s.status = SourceStatus::Active;
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

        let handle = WorkerHandle {
            id: dest.id.clone(),
            kind: WorkerKind::Dest,
            process: child,
            restart_count: 0,
            last_restart: None,
            error: false,
        };

        self.workers.insert(dest.id.clone(), handle);

        let mut routing = self.routing.write().await;
        if let Some(d) = routing.dests.get_mut(&dest.id) {
            d.status = DestStatus::Active;
        }

        Ok(())
    }

    /// Stop a worker by ID.
    pub async fn stop_worker(&mut self, id: &str) {
        if let Some(mut handle) = self.workers.remove(id) {
            info!("stopping worker: {id}");
            let _ = handle.process.kill().await;
        }
    }

    /// Main supervision loop: monitors worker processes and restarts crashed ones.
    pub async fn supervision_loop(&mut self) -> Result<()> {
        let mut check_interval = tokio::time::interval(Duration::from_secs(2));

        loop {
            check_interval.tick().await;

            let mut crashed: Vec<(String, WorkerKind)> = Vec::new();

            for (id, handle) in &mut self.workers {
                match handle.process.try_wait() {
                    Ok(Some(status)) => {
                        if handle.error {
                            continue; // already marked as errored out
                        }
                        warn!("worker {id} exited with status: {status}");
                        crashed.push((id.clone(), handle.kind.clone()));
                    }
                    Ok(None) => {} // still running
                    Err(e) => {
                        warn!("worker {id} wait error: {e}");
                    }
                }
            }

            for (id, kind) in crashed {
                self.handle_crash(&id, &kind).await;
            }
        }
    }

    async fn handle_crash(&mut self, id: &str, kind: &WorkerKind) {
        let max_restarts = self.config.supervisor.max_restarts;
        let restart_window = Duration::from_secs(self.config.supervisor.restart_window_secs);

        let handle = match self.workers.get_mut(id) {
            Some(h) => h,
            None => return,
        };

        // Reset restart counter if outside the window
        if let Some(last) = handle.last_restart {
            if last.elapsed() > restart_window {
                handle.restart_count = 0;
            }
        }

        if handle.restart_count >= max_restarts {
            error!("worker {id} exceeded max restarts ({max_restarts}), giving up");
            handle.error = true;

            // Update status in routing table
            let mut routing = self.routing.write().await;
            match kind {
                WorkerKind::Source => {
                    if let Some(s) = routing.sources.get_mut(id) {
                        s.status = SourceStatus::Error;
                    }
                }
                WorkerKind::Dest => {
                    if let Some(d) = routing.dests.get_mut(id) {
                        d.status = DestStatus::Error;
                    }
                }
            }
            return;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        let delay = Duration::from_secs(1 << handle.restart_count.min(4));
        handle.restart_count += 1;
        handle.last_restart = Some(Instant::now());

        info!("restarting worker {id} (attempt {}) after {}s", handle.restart_count, delay.as_secs());
        tokio::time::sleep(delay).await;

        // Re-read source/dest config from routing table and restart
        let routing_r = self.routing.read().await;
        match kind {
            WorkerKind::Source => {
                if let Some(source) = routing_r.sources.get(id).cloned() {
                    drop(routing_r);
                    if let Err(e) = self.start_source(&source).await {
                        error!("failed to restart source {id}: {e}");
                    }
                }
            }
            WorkerKind::Dest => {
                if let Some(dest) = routing_r.dests.get(id).cloned() {
                    let source_id = routing_r.source_for_dest(id);
                    let source_port = source_id.and_then(|sid| {
                        routing_r.sources.get(&sid).and_then(|s| s.internal_port)
                    });
                    drop(routing_r);
                    if let Some(port) = source_port {
                        if let Err(e) = self.start_dest(&dest, port).await {
                            error!("failed to restart dest {id}: {e}");
                        }
                    } else {
                        warn!("cannot restart dest {id}: source not found or has no port");
                    }
                }
            }
        }
    }

    pub fn worker_count(&self) -> usize {
        self.workers.len()
    }
}
