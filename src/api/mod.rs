pub mod assignments;
pub mod auth;
pub mod control;
pub mod devices;
pub mod organizations;
pub mod telemetry;
pub mod users;

use axum::{
    routing::{delete, get, patch, post},
    Router,
};

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        // Auth
        .route("/api/v1/auth/login", post(auth::login))
        .route("/api/v1/auth/refresh", post(auth::refresh))
        .route("/api/v1/auth/me", get(auth::me))
        // Org
        .route("/api/v1/org", get(organizations::get_org))
        // Users
        .route("/api/v1/users", get(users::list_users).post(users::create_user))
        .route(
            "/api/v1/users/:id",
            patch(users::update_user).delete(users::delete_user),
        )
        // Devices
        .route(
            "/api/v1/devices",
            get(devices::list_devices),
        )
        .route("/api/v1/devices/unassigned", get(devices::list_unassigned_devices))
        .route("/api/v1/devices/:id", get(devices::get_device).delete(devices::decommission_device))
        .route("/api/v1/devices/:id/claim-to-org", post(devices::claim_device_to_org))
        // Assignments
        .route(
            "/api/v1/devices/:id/assignments",
            get(assignments::list_assignments).post(assignments::create_assignment),
        )
        .route(
            "/api/v1/devices/:id/assignments/:user_id",
            delete(assignments::delete_assignment),
        )
        // Control
        .route("/api/v1/devices/:id/control/claim", post(control::claim_control))
        .route("/api/v1/devices/:id/control/release", post(control::release_control))
        .route("/api/v1/devices/:id/control/command", post(control::send_command))
        // Telemetry
        .route("/api/v1/devices/:id/telemetry/live", get(telemetry::live_telemetry))
        .route("/api/v1/devices/:id/telemetry/history", get(telemetry::telemetry_history))
        .route("/api/v1/devices/:id/telemetry/stream", get(telemetry::telemetry_stream))
}
