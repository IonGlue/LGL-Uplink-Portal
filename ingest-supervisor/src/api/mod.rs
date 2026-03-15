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
use crate::routing::{DestSlot, DestStatus, RoutingEntry, RoutingTable, SourceSlot, SourceStatus};
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
    Json(mut body): Json<Value>,
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
            .and_then(|sid| routing.sources.get(&sid).and_then(|s| s.internal_port));
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

    // Auto-start dest if source is active
    let (dest, source_port) = {
        let routing = state.routing.read().await;
        let dest = routing.dests.get(&dest_id).cloned();
        let source_port = routing.sources.get(&source_id).and_then(|s| s.internal_port);
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
