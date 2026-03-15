use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};

/// Represents a source slot in the patchbay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSlot {
    pub id: String,
    pub name: String,
    pub source_type: String,  // encoder | test_pattern | srt_listen | srt_pull | placeholder
    pub config: serde_json::Value,
    pub internal_port: Option<u16>,
    pub status: SourceStatus,
    pub process_pid: Option<u32>,
    pub position_x: f32,
    pub position_y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    Idle,
    Starting,
    Active,
    Error,
    Placeholder,
}

/// Represents a destination slot in the patchbay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestSlot {
    pub id: String,
    pub name: String,
    pub dest_type: String,  // rtmp | srt_push | hls | recorder | placeholder
    pub config: serde_json::Value,
    pub status: DestStatus,
    pub process_pid: Option<u32>,
    pub position_x: f32,
    pub position_y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DestStatus {
    Idle,
    Starting,
    Active,
    Error,
    Placeholder,
}

/// A routing entry: one source → one destination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingEntry {
    pub id: String,
    pub source_id: String,
    pub dest_id: String,
    pub enabled: bool,
}

/// In-memory routing state (persisted to DB via the TypeScript server).
pub struct RoutingTable {
    pub sources: HashMap<String, SourceSlot>,
    pub dests: HashMap<String, DestSlot>,
    pub routes: Vec<RoutingEntry>,
}

impl RoutingTable {
    pub fn new() -> Self {
        Self {
            sources: HashMap::new(),
            dests: HashMap::new(),
            routes: Vec::new(),
        }
    }

    pub fn add_source(&mut self, source: SourceSlot) {
        self.sources.insert(source.id.clone(), source);
    }

    pub fn remove_source(&mut self, id: &str) {
        self.sources.remove(id);
        // Remove any routes that reference this source
        self.routes.retain(|r| r.source_id != id);
    }

    pub fn add_dest(&mut self, dest: DestSlot) {
        self.dests.insert(dest.id.clone(), dest);
    }

    pub fn remove_dest(&mut self, id: &str) {
        self.dests.remove(id);
        self.routes.retain(|r| r.dest_id != id);
    }

    pub fn add_route(&mut self, route: RoutingEntry) {
        // Prevent duplicates
        if !self.routes.iter().any(|r| r.source_id == route.source_id && r.dest_id == route.dest_id) {
            self.routes.push(route);
        }
    }

    pub fn remove_route(&mut self, route_id: &str) {
        self.routes.retain(|r| r.id != route_id);
    }

    /// Get all destination IDs connected to a given source.
    pub fn dests_for_source(&self, source_id: &str) -> Vec<String> {
        self.routes
            .iter()
            .filter(|r| r.source_id == source_id && r.enabled)
            .map(|r| r.dest_id.clone())
            .collect()
    }

    /// Get source ID connected to a given destination.
    pub fn source_for_dest(&self, dest_id: &str) -> Option<String> {
        self.routes
            .iter()
            .find(|r| r.dest_id == dest_id && r.enabled)
            .map(|r| r.source_id.clone())
    }

    /// Get all active source IDs.
    pub fn active_source_ids(&self) -> HashSet<String> {
        self.routes
            .iter()
            .filter(|r| r.enabled)
            .map(|r| r.source_id.clone())
            .collect()
    }
}
