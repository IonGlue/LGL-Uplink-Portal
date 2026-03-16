use std::sync::Arc;

use anyhow::Result;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::port_pool::PortPool;
use crate::routing::{DestSlot, DestStatus, RoutingEntry, RoutingTable,
                     SourceSlot, SourceStatus, SyncGroup, SyncGroupStatus};
use crate::supervisor::Supervisor;

#[derive(Clone)]
pub struct ApiState {
    pub supervisor: Arc<RwLock<Supervisor>>,
    pub routing: Arc<RwLock<RoutingTable>>,
    pub port_pool: Arc<RwLock<PortPool>>,
}

pub async fn serve(
    addr: String,
    supervisor: Arc<RwLock<Supervisor>>,
    routing: Arc<RwLock<RoutingTable>>,
    port_pool: Arc<RwLock<PortPool>>,
) -> Result<()> {
    let state = ApiState { supervisor, routing, port_pool };

    let app = Router::new()
        .route("/health", get(health))
        .route("/sources", get(list_sources).post(create_source))
        .route("/sources/:id", get(get_source).delete(delete_source))
        .route("/sources/:id/start", post(start_source))
        .route("/sources/:id/stop", post(stop_source))
        .route("/dests", get(list_dests).post(create_dest))
        .route("/dests/:id", get(get_dest).delete(delete_dest))
        .route("/dests/:id/start", post(start_dest))
        .route("/dests/:id/stop", post(stop_dest))
        .route("/routes", get(list_routes).post(create_route))
        .route("/routes/:id", delete(delete_route))
        // Sync group endpoints
        .route("/sync-groups", get(list_sync_groups).post(create_sync_group))
        .route("/sync-groups/:id", get(get_sync_group).put(update_sync_group).delete(delete_sync_group))
        .route("/sync-groups/:id/start", post(start_sync_group))
        .route("/sync-groups/:id/stop", post(stop_sync_group))
        .route("/sync-groups/:id/status", get(sync_group_status))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    log::info!("supervisor API listening on {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

// --- Health ---

async fn health(State(state): State<ApiState>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    let pool = state.port_pool.read().await;
    Json(json!({
        "status": "ok",
        "sources": routing.sources.len(),
        "dests": routing.dests.len(),
        "routes": routing.routes.len(),
        "ports_used": pool.allocated_count(),
        "ports_total": pool.capacity(),
    }))
}

// --- Sources ---

async fn list_sources(State(state): State<ApiState>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    let sources: Vec<&SourceSlot> = routing.sources.values().collect();
    Json(json!({ "sources": sources }))
}

async fn get_source(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    match routing.sources.get(&id) {
        Some(s) => (StatusCode::OK, Json(json!(s))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response(),
    }
}

async fn create_source(
    State(state): State<ApiState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let id = body.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("Unnamed").to_string();
    let source_type = match body.get("source_type").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({"error": "source_type required"}))).into_response(),
    };

    let is_placeholder = source_type == "placeholder";
    let config = body.get("config").cloned().unwrap_or(json!({}));
    let position_x = body.get("position_x").and_then(|v| v.as_f64()).unwrap_or(100.0) as f32;
    let position_y = body.get("position_y").and_then(|v| v.as_f64()).unwrap_or(100.0) as f32;

    // Allocate an internal port for non-placeholder sources
    let internal_port = if is_placeholder {
        None
    } else {
        let mut pool = state.port_pool.write().await;
        match pool.allocate() {
            Some(p) => Some(p),
            None => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "no ports available"}))).into_response(),
        }
    };

    let source = SourceSlot {
        id: id.clone(),
        name,
        source_type,
        config,
        internal_port,
        status: if is_placeholder { SourceStatus::Placeholder } else { SourceStatus::Idle },
        process_pid: None,
        position_x,
        position_y,
    };

    state.routing.write().await.add_source(source.clone());

    (StatusCode::CREATED, Json(json!(source))).into_response()
}

async fn delete_source(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    // Stop the worker if running
    state.supervisor.write().await.stop_worker(&id).await;

    // Release port
    {
        let routing = state.routing.read().await;
        if let Some(s) = routing.sources.get(&id) {
            if let Some(port) = s.internal_port {
                state.port_pool.write().await.release(port);
            }
        }
    }

    state.routing.write().await.remove_source(&id);
    Json(json!({"deleted": true}))
}

async fn start_source(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    let source = {
        let routing = state.routing.read().await;
        routing.sources.get(&id).cloned()
    };

    match source {
        Some(s) => {
            if s.source_type == "placeholder" {
                return (StatusCode::BAD_REQUEST, Json(json!({"error": "placeholder sources cannot be started"}))).into_response();
            }
            match state.supervisor.write().await.start_source(&s).await {
                Ok(_) => Json(json!({"started": true})).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))).into_response(),
            }
        }
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response(),
    }
}

async fn stop_source(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    state.supervisor.write().await.stop_worker(&id).await;

    let mut routing = state.routing.write().await;
    if let Some(s) = routing.sources.get_mut(&id) {
        s.status = SourceStatus::Idle;
    }

    Json(json!({"stopped": true}))
}

// --- Dests ---

async fn list_dests(State(state): State<ApiState>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    let dests: Vec<&DestSlot> = routing.dests.values().collect();
    Json(json!({ "dests": dests }))
}

async fn get_dest(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    match routing.dests.get(&id) {
        Some(d) => (StatusCode::OK, Json(json!(d))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response(),
    }
}

async fn create_dest(
    State(state): State<ApiState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let id = body.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("Unnamed").to_string();
    let dest_type = match body.get("dest_type").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({"error": "dest_type required"}))).into_response(),
    };

    let config = body.get("config").cloned().unwrap_or(json!({}));
    let position_x = body.get("position_x").and_then(|v| v.as_f64()).unwrap_or(800.0) as f32;
    let position_y = body.get("position_y").and_then(|v| v.as_f64()).unwrap_or(100.0) as f32;
    let is_placeholder = dest_type == "placeholder";

    let dest = DestSlot {
        id: id.clone(),
        name,
        dest_type,
        config,
        status: if is_placeholder { DestStatus::Placeholder } else { DestStatus::Idle },
        process_pid: None,
        position_x,
        position_y,
    };

    state.routing.write().await.add_dest(dest.clone());
    (StatusCode::CREATED, Json(json!(dest))).into_response()
}

async fn delete_dest(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    state.supervisor.write().await.stop_worker(&id).await;
    state.routing.write().await.remove_dest(&id);
    Json(json!({"deleted": true}))
}

async fn start_dest(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    let (dest, source_port) = {
        let routing = state.routing.read().await;
        let dest = routing.dests.get(&id).cloned();
        let source_port = routing.source_for_dest(&id)
            .and_then(|sid| routing.effective_port_for_source(&sid));
        (dest, source_port)
    };

    match (dest, source_port) {
        (Some(d), Some(port)) => {
            if d.dest_type == "placeholder" {
                return (StatusCode::BAD_REQUEST, Json(json!({"error": "placeholder dests cannot be started"}))).into_response();
            }
            match state.supervisor.write().await.start_dest(&d, port).await {
                Ok(_) => Json(json!({"started": true})).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()}))).into_response(),
            }
        }
        (None, _) => (StatusCode::NOT_FOUND, Json(json!({"error": "dest not found"}))).into_response(),
        (_, None) => (StatusCode::BAD_REQUEST, Json(json!({"error": "no active source routed to this dest"}))).into_response(),
    }
}

async fn stop_dest(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    state.supervisor.write().await.stop_worker(&id).await;
    let mut routing = state.routing.write().await;
    if let Some(d) = routing.dests.get_mut(&id) {
        d.status = DestStatus::Idle;
    }
    Json(json!({"stopped": true}))
}

// --- Routes ---

async fn list_routes(State(state): State<ApiState>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    Json(json!({ "routes": routing.routes }))
}

async fn create_route(
    State(state): State<ApiState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let source_id = match body.get("source_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({"error": "source_id required"}))).into_response(),
    };
    let dest_id = match body.get("dest_id").and_then(|v| v.as_str()) {
        Some(d) => d.to_string(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({"error": "dest_id required"}))).into_response(),
    };

    let route_id = Uuid::new_v4().to_string();
    let route = RoutingEntry {
        id: route_id.clone(),
        source_id: source_id.clone(),
        dest_id: dest_id.clone(),
        enabled: true,
    };

    // Verify both exist
    {
        let routing = state.routing.read().await;
        if !routing.sources.contains_key(&source_id) {
            return (StatusCode::NOT_FOUND, Json(json!({"error": "source not found"}))).into_response();
        }
        if !routing.dests.contains_key(&dest_id) {
            return (StatusCode::NOT_FOUND, Json(json!({"error": "dest not found"}))).into_response();
        }
    }

    state.routing.write().await.add_route(route.clone());

    // Auto-start dest only when the source is already Active (has a live
    // process) and has an effective port.  Skipping this when the source is
    // Idle/Starting prevents starting a dest that has nowhere to connect.
    let (dest, source_port) = {
        let routing = state.routing.read().await;
        let dest = routing.dests.get(&dest_id).cloned();
        let source_active = routing.sources.get(&source_id)
            .map(|s| s.status == SourceStatus::Active)
            .unwrap_or(false);
        let source_port = if source_active {
            routing.effective_port_for_source(&source_id)
        } else {
            None
        };
        (dest, source_port)
    };

    if let (Some(d), Some(port)) = (dest, source_port) {
        if d.dest_type != "placeholder" {
            if let Err(e) = state.supervisor.write().await.start_dest(&d, port).await {
                log::warn!("auto-start dest {dest_id} failed: {e}");
            }
        }
    }

    (StatusCode::CREATED, Json(json!(route))).into_response()
}

async fn delete_route(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    // Find the dest associated with this route and stop it
    let dest_id = {
        let routing = state.routing.read().await;
        routing.routes.iter().find(|r| r.id == id).map(|r| r.dest_id.clone())
    };

    if let Some(did) = dest_id {
        state.supervisor.write().await.stop_worker(&did).await;
        let mut routing = state.routing.write().await;
        if let Some(d) = routing.dests.get_mut(&did) {
            d.status = DestStatus::Idle;
        }
    }

    state.routing.write().await.remove_route(&id);
    Json(json!({"deleted": true}))
}

// ── Sync groups ───────────────────────────────────────────────────────────────

async fn list_sync_groups(State(state): State<ApiState>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    let groups: Vec<&SyncGroup> = routing.sync_groups.values().collect();
    Json(json!({ "sync_groups": groups }))
}

async fn get_sync_group(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    match routing.sync_groups.get(&id) {
        Some(g) => (StatusCode::OK, Json(json!(g))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "sync group not found"}))).into_response(),
    }
}

async fn create_sync_group(
    State(state): State<ApiState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let id = body.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("Unnamed sync group").to_string();
    let target_delay_ms = body.get("target_delay_ms").and_then(|v| v.as_u64()).unwrap_or(500) as u32;
    let max_offset_ms = body.get("max_offset_ms").and_then(|v| v.as_u64()).unwrap_or(2000) as u32;
    let source_ids: Vec<String> = body.get("source_ids")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    // Validate that all source IDs exist
    {
        let routing = state.routing.read().await;
        for sid in &source_ids {
            if !routing.sources.contains_key(sid) {
                return (StatusCode::NOT_FOUND,
                    Json(json!({"error": format!("source not found: {sid}")}))).into_response();
            }
        }
    }

    let group = SyncGroup {
        id: id.clone(),
        name,
        target_delay_ms,
        max_offset_ms,
        source_ids,
        aligned_ports: std::collections::HashMap::new(),
        status: SyncGroupStatus::Idle,
    };

    state.routing.write().await.add_sync_group(group.clone());
    (StatusCode::CREATED, Json(json!(group))).into_response()
}

async fn update_sync_group(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let mut routing = state.routing.write().await;
    let group = match routing.sync_groups.get_mut(&id) {
        Some(g) => g,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error": "sync group not found"}))).into_response(),
    };

    if let Some(v) = body.get("name").and_then(|v| v.as_str()) {
        group.name = v.to_string();
    }
    if let Some(v) = body.get("target_delay_ms").and_then(|v| v.as_u64()) {
        group.target_delay_ms = v as u32;
    }
    if let Some(v) = body.get("max_offset_ms").and_then(|v| v.as_u64()) {
        group.max_offset_ms = v as u32;
    }
    if let Some(arr) = body.get("source_ids").and_then(|v| v.as_array()) {
        group.source_ids = arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
    }
    // Allow the server to restore persisted aligned ports after a supervisor restart.
    if let Some(obj) = body.get("aligned_ports").and_then(|v| v.as_object()) {
        group.aligned_ports = obj.iter()
            .filter_map(|(k, v)| v.as_u64().map(|p| (k.clone(), p as u16)))
            .collect();
        group.status = SyncGroupStatus::Active;
    }

    let group = group.clone();
    (StatusCode::OK, Json(json!(group))).into_response()
}

async fn delete_sync_group(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    // Stop the sync worker if running.
    state.supervisor.write().await.stop_worker(&id).await;
    state.routing.write().await.remove_sync_group(&id);
    Json(json!({"deleted": true}))
}

async fn start_sync_group(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    // Allocate aligned output ports from the port pool.
    let (_group, port_assignments) = {
        let routing = state.routing.read().await;
        let group = match routing.sync_groups.get(&id) {
            Some(g) => g.clone(),
            None => return (StatusCode::NOT_FOUND, Json(json!({"error": "sync group not found"}))).into_response(),
        };

        // Collect source IDs that need aligned ports.
        let mut pool = state.port_pool.write().await;
        let mut assignments = std::collections::HashMap::new();
        for sid in &group.source_ids {
            if routing.sources.get(sid).and_then(|s| s.internal_port).is_none() {
                return (StatusCode::BAD_REQUEST,
                    Json(json!({"error": format!("source {sid} has no internal_port — start it first")}))).into_response();
            }
            match pool.allocate() {
                Some(port) => { assignments.insert(sid.clone(), port); }
                None => {
                    // Release any ports we just allocated.
                    for p in assignments.values() { pool.release(*p); }
                    return (StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({"error": "no ports available for aligned outputs"}))).into_response();
                }
            }
        }
        (group, assignments)
    };

    // Update group with aligned ports and status.
    {
        let mut routing = state.routing.write().await;
        if let Some(g) = routing.sync_groups.get_mut(&id) {
            g.aligned_ports = port_assignments;
            g.status = SyncGroupStatus::Active;
        }
    }

    // Spawn the ingest-sync worker.
    let (group_snapshot, routing_snapshot) = {
        let routing = state.routing.read().await;
        (routing.sync_groups.get(&id).cloned(), routing.clone_for_sync())
    };
    if let Some(group) = group_snapshot {
        if let Err(e) = state.supervisor.write().await
            .start_sync_group(&group, &routing_snapshot).await
        {
            let mut routing = state.routing.write().await;
            if let Some(g) = routing.sync_groups.get_mut(&id) {
                g.status = SyncGroupStatus::Error;
            }
            return (StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()}))).into_response();
        }
    }

    // Return aligned port assignments so the server can persist them.
    let aligned_ports: std::collections::HashMap<String, u16> = {
        let routing = state.routing.read().await;
        routing.sync_groups.get(&id)
            .map(|g| g.aligned_ports.clone())
            .unwrap_or_default()
    };

    Json(json!({"started": true, "aligned_ports": aligned_ports})).into_response()
}

async fn stop_sync_group(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    state.supervisor.write().await.stop_worker(&id).await;

    // Release aligned ports back to the pool.
    let ports: Vec<u16> = {
        let routing = state.routing.read().await;
        routing.sync_groups.get(&id)
            .map(|g| g.aligned_ports.values().copied().collect())
            .unwrap_or_default()
    };
    {
        let mut pool = state.port_pool.write().await;
        for p in ports { pool.release(p); }
    }

    let mut routing = state.routing.write().await;
    if let Some(g) = routing.sync_groups.get_mut(&id) {
        g.status = SyncGroupStatus::Idle;
        g.aligned_ports.clear();
    }
    Json(json!({"stopped": true}))
}

async fn sync_group_status(State(state): State<ApiState>, Path(id): Path<String>) -> impl IntoResponse {
    let routing = state.routing.read().await;
    let group = match routing.sync_groups.get(&id) {
        Some(g) => g,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error": "sync group not found"}))).into_response(),
    };

    // Build per-stream status: source_id → aligned_port, internal_port, status
    let streams: Vec<Value> = group.source_ids.iter().map(|sid| {
        let internal_port = routing.sources.get(sid).and_then(|s| s.internal_port);
        let aligned_port = group.aligned_ports.get(sid).copied();
        json!({
            "source_id": sid,
            "internal_port": internal_port,
            "aligned_port": aligned_port,
        })
    }).collect();

    Json(json!({
        "id": group.id,
        "name": group.name,
        "status": group.status,
        "target_delay_ms": group.target_delay_ms,
        "max_offset_ms": group.max_offset_ms,
        "streams": streams,
    })).into_response()
}
