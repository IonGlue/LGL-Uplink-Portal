# LGL-Ingest — Server-Side Platform Specification
> Complete build specification for the LGL-Ingest service.
> This document is a self-contained prompt for building the server-side platform
> that LGL Uplink devices connect to.
---
## 1. What You Are Building
**LGL-Ingest** is the server-side platform for the LGL Uplink bonded encoder system. It is a multi-tenant web service that:
1. Accepts persistent WebSocket connections from field encoder devices
2. Registers new devices automatically on first connect (phone-home model)
3. Stores real-time telemetry (per-path network stats, encoder state, uptime)
4. Routes commands from authenticated portal users to their assigned devices
5. Provides a REST API for a web dashboard (device list, telemetry, controls)
6. Enforces a multi-tenant security model (organizations → users → devices)
The device-side client already exists in the `LGL-Uplink` repository. This spec describes the **server** that devices connect to and the **portal API** that the web dashboard consumes.
---
## 2. Architecture Overview
```
┌─────────────────────────────────────────────────────────────────┐
│                        LGL-Ingest Server                        │
│                                                                 │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐   │
│  │ WebSocket   │   │  REST API    │   │   Background Jobs  │   │
│  │ Gateway     │   │  (Portal)    │   │   - Stale cleanup  │   │
│  │             │   │              │   │   - Token rotation  │   │
│  │ /devices    │   │ /api/v1/...  │   │   - Telemetry TTL  │   │
│  └──────┬──────┘   └──────┬───────┘   └────────┬───────────┘   │
│         │                 │                     │               │
│  ┌──────┴─────────────────┴─────────────────────┴───────────┐   │
│  │                     Application Layer                     │   │
│  │  - Device registry       - Telemetry ingestion           │   │
│  │  - Auth (JWT)            - Command routing                │   │
│  │  - Organization/User     - Claim/release mutex            │   │
│  │    management            - Audit logging                  │   │
│  └──────────────────────────┬────────────────────────────────┘   │
│                             │                                    │
│  ┌──────────────────────────┴────────────────────────────────┐   │
│  │                      Data Layer                            │   │
│  │  PostgreSQL (devices, orgs, users, assignments, audit)     │   │
│  │  Redis (live telemetry cache, WebSocket session state,     │   │
│  │         pub/sub for command routing)                        │   │
│  └────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         ▲ WSS                              ▲ HTTPS
         │                                  │
    ┌────┴─────┐                     ┌──────┴───────┐
    │  Uplink  │  (many devices)     │  Web Portal  │  (Next.js dashboard)
    │  Devices │                     │  (separate)  │
    └──────────┘                     └──────────────┘
```
---
## 3. Tech Stack
| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | **Rust** | Matches device codebase; excellent async WebSocket performance |
| Web framework | **Axum** | Tokio-native, tower middleware, great WebSocket support |
| Database | **PostgreSQL** | Relational data model, JSONB for telemetry snapshots |
| Cache / Pub-Sub | **Redis** | Live telemetry cache, WS session tracking, command fan-out |
| Auth | **JWT** (short-lived) | Device auth tokens + portal user tokens |
| ORM / Queries | **sqlx** | Compile-time checked SQL, async PostgreSQL driver |
| Migrations | **sqlx migrate** | Embedded in the binary |
| Config | **TOML** (via `config` crate or `toml`) | Consistent with device config |
| Logging | **tracing** + **tracing-subscriber** | Structured logging with span context |
| Deployment | **Docker** | Single container with health checks |

### Cargo.toml Dependencies
```toml
[dependencies]
axum = { version = "0.8", features = ["ws", "macros"] }
axum-extra = { version = "0.10", features = ["typed-header"] }
tokio = { version = "1", features = ["full"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["cors", "trace", "compression-gzip"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "uuid", "chrono", "json"] }
redis = { version = "0.27", features = ["tokio-comp", "connection-manager"] }
jsonwebtoken = "9"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
argon2 = "0.5"
rand = "0.8"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
toml = "0.8"
anyhow = "1"
thiserror = "2"
```
---
## 4. Database Schema
### Tables
```sql
-- Organizations (tenants)
CREATE TABLE organizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,  -- URL-safe identifier
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Users (portal accounts)
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,          -- argon2
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'viewer',  -- 'admin', 'operator', 'viewer'
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_email ON users(email);
-- Devices (registered uplink encoders)
CREATE TABLE devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       TEXT NOT NULL UNIQUE,   -- 64-char hex from device
    hardware_id     TEXT NOT NULL,           -- MAC-based fingerprint
    hostname        TEXT NOT NULL DEFAULT 'uplink',
    version         TEXT NOT NULL DEFAULT '0.0.0',
    org_id          UUID REFERENCES organizations(id) ON DELETE SET NULL,  -- NULL = unassigned
    status          TEXT NOT NULL DEFAULT 'offline',  -- 'online', 'offline'
    last_state      TEXT NOT NULL DEFAULT 'idle',     -- last known DeviceState
    last_seen_at    TIMESTAMPTZ,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_device_id ON devices(device_id);
CREATE INDEX idx_devices_org ON devices(org_id);
CREATE INDEX idx_devices_hardware_id ON devices(hardware_id);
-- Device ↔ User assignments (many-to-many)
CREATE TABLE device_assignments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES users(id),  -- admin who made the assignment
    UNIQUE(device_id, user_id)
);
CREATE INDEX idx_assignments_device ON device_assignments(device_id);
CREATE INDEX idx_assignments_user ON device_assignments(user_id);
-- Control claims (mutex: only one user controls a device at a time)
CREATE TABLE control_claims (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL  -- auto-release after timeout
);
-- Telemetry snapshots (recent history, pruned by TTL)
CREATE TABLE telemetry (
    id          BIGSERIAL PRIMARY KEY,
    device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts          TIMESTAMPTZ NOT NULL,
    state       TEXT NOT NULL,
    payload     JSONB NOT NULL,  -- full telemetry report
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_telemetry_device_ts ON telemetry(device_id, ts DESC);
-- Partition by time or prune with a background job (keep ~24h)
-- Audit log
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_type  TEXT NOT NULL,            -- 'user', 'system', 'device'
    actor_id    UUID,
    action      TEXT NOT NULL,            -- 'device.register', 'command.send', 'claim.acquire', etc.
    target_type TEXT,                     -- 'device', 'user', 'org'
    target_id   UUID,
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id, created_at DESC);
```
### Redis Keys
```
# Live telemetry (latest snapshot per device, TTL 30s)
telemetry:{device_uuid}  → JSON blob

# WebSocket session tracking
ws:session:{device_uuid}  → server_instance_id  (TTL 60s, refreshed by heartbeat)

# Command pub/sub channel
commands:{device_uuid}  → Redis Pub/Sub channel

# Rate limiting
ratelimit:{ip}:{endpoint}  → counter (TTL window)
```
---
## 5. WebSocket Gateway — Device Protocol
This is the **exact wire protocol** that devices already implement. The server must match it precisely.
### Endpoint
```
wss://ingest.lgl-os.com/devices
```
All communication is **JSON over WebSocket text frames**. Every message has a `msg_type` field.
### 5.1 Device → Server: Register
Sent once on first connect (or reconnect without a valid token).
```json
{
  "msg_type": "register",
  "device_id": "a1b2c3d4e5f6...",
  "hardware_id": "aa:bb:cc:dd:ee:ff+11:22:33:44:55:66",
  "hostname": "uplink-01",
  "version": "0.1.0"
}
```
- `device_id`: 64-character hex string, generated on first boot, persisted on device
- `hardware_id`: deterministic from MAC addresses (sorted, joined with `+`), or hostname fallback
- Sent once per connection

**Server behavior:**
1. Look up `device_id` in the `devices` table
2. If not found → INSERT new device (status: online, org_id: NULL = unassigned)
3. If found with same `hardware_id` → update hostname, version, set status=online, update last_seen_at
4. If found with different `hardware_id` → this is a re-flash. Log an audit event. Update hardware_id, require admin re-approval if org was assigned (optional: just accept it)
5. Generate a short-lived JWT (1 hour expiry) containing `{ sub: device_uuid, device_id: "a1b2...", type: "device" }`
6. Send register response

### 5.2 Server → Device: Register Response
```json
{
  "msg_type": "register_response",
  "device_id": "a1b2c3d4e5f6...",
  "auth_token": "eyJ..."
}
```
### 5.3 Device → Server: Telemetry
Pushed every ~500ms while connected.
```json
{
  "msg_type": "telemetry",
  "ts": 1710432000,
  "state": "streaming",
  "paths": [
    {
      "interface": "eth0",
      "bitrate_kbps": 3200,
      "rtt_ms": 25.0,
      "loss_pct": 0.1,
      "in_flight": 5,
      "window": 20000
    },
    {
      "interface": "usb0",
      "bitrate_kbps": 1800,
      "rtt_ms": 80.0,
      "loss_pct": 1.5,
      "in_flight": 12,
      "window": 15000
    }
  ],
  "encoder": {
    "pipeline": "h264_v4l2_usb",
    "bitrate_kbps": 5000,
    "fps": 29.97,
    "resolution": "1920x1080"
  },
  "uptime_secs": 3600
}
```
**Device states:** `idle`, `starting`, `streaming`, `stopping`, `error`

**Server behavior:**
1. Validate `msg_type` = `"telemetry"`, validate basic schema
2. Update Redis live cache: `SET telemetry:{device_uuid} <json> EX 30`
3. Update `devices` table: `last_state`, `last_seen_at`
4. Periodically (every ~5th message, or every 2.5s) insert into `telemetry` table for history
5. **Telemetry is advisory only** — display on dashboard, never use as trusted input for actions affecting other tenants

### 5.4 Server → Device: Commands
All commands use `msg_type: "command"` with a `cmd` field. The device deserializes into a **closed enum** — unknown commands are silently dropped.

#### Start
```json
{ "msg_type": "command", "cmd": "start" }
```
#### Stop
```json
{ "msg_type": "command", "cmd": "stop" }
```
#### Set Bitrate Range
```json
{
  "msg_type": "command",
  "cmd": "set_bitrate_range",
  "min_kbps": 2000,
  "max_kbps": 8000
}
```
Constraints: `min_kbps` <= `max_kbps`, `max_kbps` <= 100000

#### Set Pipeline
```json
{
  "msg_type": "command",
  "cmd": "set_pipeline",
  "variant": "h265_v4l2_usb"
}
```
Valid variants: `h264_v4l2_usb`, `h265_v4l2_usb`, `h264_qsv`

**Server behavior when routing a command:**
1. Portal user calls REST API to send command
2. Server validates the user has an active control claim on the device
3. Server validates command payload (bitrate bounds, pipeline whitelist)
4. Publish command to Redis channel `commands:{device_uuid}`
5. The WS handler for that device subscribes to the channel and forwards the JSON to the device
6. Log to audit_log

### 5.5 Connection Lifecycle
```
Device connects → WSS handshake
  → Device sends "register"
  → Server sends "register_response" (with JWT)
  → Device pushes "telemetry" every ~500ms
  → Server pushes "command" messages as needed
  → Server sends WebSocket Ping every 30s
  → Device responds with Pong
  → On disconnect: set device status=offline, last_seen_at=now
```
### 5.6 Token Refresh
The server should send a new JWT before the current one expires. This is done by sending a `register_response` message with a fresh token mid-connection:
```json
{
  "msg_type": "register_response",
  "device_id": "a1b2c3d4...",
  "auth_token": "eyJ...(new token)"
}
```
The device stores the new token and uses it on next reconnect.

---
## 6. REST API — Portal
Base URL: `/api/v1`

All portal endpoints require a Bearer JWT token (user auth, separate from device auth).

### 6.1 Authentication
#### POST /api/v1/auth/login
```json
// Request
{ "email": "admin@example.com", "password": "..." }
// Response 200
{
  "token": "eyJ...",
  "user": {
    "id": "uuid",
    "email": "admin@example.com",
    "display_name": "Admin",
    "role": "admin",
    "org_id": "uuid"
  }
}
```
#### POST /api/v1/auth/refresh
```json
// Request (Bearer token in header)
// Response 200
{ "token": "eyJ...(new)" }
```
#### GET /api/v1/auth/me
Returns current user profile.

### 6.2 Organizations
#### GET /api/v1/org
Returns the current user's organization.
```json
{
  "id": "uuid",
  "name": "Acme Broadcasting",
  "slug": "acme-broadcasting",
  "device_count": 12,
  "user_count": 5
}
```
### 6.3 Users (admin only)
#### GET /api/v1/users
List users in the organization.

#### POST /api/v1/users
Create a new user. Admin only.
```json
{
  "email": "operator@example.com",
  "display_name": "Field Operator",
  "role": "operator",
  "password": "..."
}
```
Roles:
- `admin` — manage users, assign devices, send commands
- `operator` — claim devices, send commands, view telemetry
- `viewer` — view telemetry only, no commands

#### PATCH /api/v1/users/:id
Update user role or display name.

#### DELETE /api/v1/users/:id
Remove user from organization. Admin only.

### 6.4 Devices
#### GET /api/v1/devices
List all devices in the organization. Supports filters.
```
GET /api/v1/devices?status=online&state=streaming
```
```json
{
  "devices": [
    {
      "id": "uuid",
      "device_id": "a1b2c3d4...",
      "hostname": "uplink-01",
      "version": "0.1.0",
      "status": "online",
      "last_state": "streaming",
      "last_seen_at": "2025-03-14T12:00:00Z",
      "assigned_users": ["uuid1", "uuid2"],
      "control_claimed_by": "uuid1"
    }
  ]
}
```
#### GET /api/v1/devices/:id
Get a single device with full details.

#### GET /api/v1/devices/unassigned
List devices with `org_id = NULL` (admin-only, system-wide). Used to claim new devices into an organization.

#### POST /api/v1/devices/:id/claim-to-org
Assign an unassigned device to the admin's organization. Admin only.
```json
// No body needed — assigns to the requesting user's org
```
#### DELETE /api/v1/devices/:id
Decommission a device (removes from org, clears assignments). Admin only. The device can re-register.

### 6.5 Device Assignments
#### GET /api/v1/devices/:id/assignments
List users assigned to a device.

#### POST /api/v1/devices/:id/assignments
Assign a user to a device. Admin only.
```json
{ "user_id": "uuid" }
```
#### DELETE /api/v1/devices/:id/assignments/:user_id
Remove a user's assignment. Admin only.

### 6.6 Device Control (Claim/Release + Commands)
#### POST /api/v1/devices/:id/control/claim
Acquire exclusive control of a device. Only one user can hold control at a time.
```json
// Response 200
{
  "claimed": true,
  "expires_at": "2025-03-14T12:05:00Z"
}
// Response 409 (already claimed)
{
  "error": "device is claimed by another user",
  "claimed_by": "uuid",
  "claimed_by_name": "Field Operator",
  "expires_at": "2025-03-14T12:05:00Z"
}
```
- Claims auto-expire after **5 minutes** of inactivity
- Each command sent refreshes the claim expiry
- Admins can force-release another user's claim

#### POST /api/v1/devices/:id/control/release
Release control claim.

#### POST /api/v1/devices/:id/control/command
Send a command to the device. Requires active control claim (or admin role).
```json
// Request
{ "cmd": "start" }
{ "cmd": "set_bitrate_range", "min_kbps": 2000, "max_kbps": 8000 }
{ "cmd": "set_pipeline", "variant": "h265_v4l2_usb" }
// Response 200
{ "status": "sent" }
// Response 403
{ "error": "no active control claim" }
// Response 422
{ "error": "invalid command: max_kbps exceeds 100000" }
```
### 6.7 Telemetry
#### GET /api/v1/devices/:id/telemetry/live
Returns the latest telemetry snapshot from Redis.
```json
{
  "ts": 1710432000,
  "state": "streaming",
  "paths": [...],
  "encoder": {...},
  "uptime_secs": 3600,
  "age_ms": 250
}
```
`age_ms` = how old this snapshot is (server-side computed).

#### GET /api/v1/devices/:id/telemetry/history
Returns historical telemetry. Supports time range.
```
GET /api/v1/devices/:id/telemetry/history?from=2025-03-14T11:00:00Z&to=2025-03-14T12:00:00Z&resolution=5s
```
- `resolution`: `1s`, `5s`, `30s`, `1m` — server downsamples
- Default: last 1 hour at 5s resolution
- Max range: 24 hours

#### WebSocket: /api/v1/devices/:id/telemetry/stream
Real-time telemetry stream for the portal dashboard. Server-sent events over WebSocket (portal user auth).

The server subscribes to telemetry updates for the device and forwards them in real time. This avoids polling.
```json
// Server pushes every ~500ms while subscribed
{
  "type": "telemetry",
  "data": { ...full telemetry report... }
}
```
---
## 7. Security Model
### 7.1 Device Security
- **Devices are untrusted clients.** They can only send registration and telemetry.
- **Commands are a closed enum.** The device rejects anything it doesn't recognize. There is no way to execute code via commands.
- **Telemetry is advisory.** A malicious device can only lie about its own status. Telemetry is never used as input to logic affecting other tenants.
- **All connections are device-initiated.** No inbound ports on the device. Server never reaches into devices.
- **No pre-provisioning.** Devices auto-register on first boot. Admin must assign them to an org to make them usable.

### 7.2 Portal Security
- **JWT auth** for all REST endpoints. Tokens expire in 1 hour, refresh via `/auth/refresh`.
- **Organization isolation.** Users can only see and control devices assigned to their org. Query all device endpoints with `WHERE org_id = $user_org_id`.
- **Role-based access control:**
  - `admin` — full access (user management, device assignment, commands, telemetry)
  - `operator` — claim devices, send commands, view telemetry
  - `viewer` — read-only telemetry access
- **Control claim mutex.** Only one user controls a device at a time. Prevents conflicting commands.
- **Audit logging.** Every command sent, every claim acquired/released, every device registered is logged with actor, timestamp, and details.

### 7.3 JWT Structure
**Device tokens:**
```json
{
  "sub": "device-uuid",
  "device_id": "a1b2c3d4...",
  "type": "device",
  "exp": 1710435600,
  "iat": 1710432000
}
```
**User tokens:**
```json
{
  "sub": "user-uuid",
  "org_id": "org-uuid",
  "role": "admin",
  "type": "user",
  "exp": 1710435600,
  "iat": 1710432000
}
```
Sign with HS256 using a server-side secret (configured via environment variable `JWT_SECRET`). Rotate secret by supporting two active secrets during transition.

### 7.4 Rate Limiting
- Device WebSocket: max 10 messages/second (telemetry is ~2/s)
- REST API: 100 requests/minute per user, 20 requests/minute for auth endpoints
- Device registration: 5 registrations/minute per IP

---
## 8. Application Structure
### Directory Layout
```
lgl-ingest/
├── Cargo.toml
├── Dockerfile
├── docker-compose.yml          # Postgres + Redis + app for dev
├── config/
│   └── ingest.example.toml
├── migrations/
│   ├── 001_create_organizations.sql
│   ├── 002_create_users.sql
│   ├── 003_create_devices.sql
│   ├── 004_create_assignments.sql
│   ├── 005_create_control_claims.sql
│   ├── 006_create_telemetry.sql
│   └── 007_create_audit_log.sql
└── src/
    ├── main.rs                 # Entry point, router setup
    ├── config.rs               # TOML config loading
    ├── error.rs                # Error types + Axum IntoResponse
    ├── db.rs                   # sqlx pool setup + migrations
    ├── auth/
    │   ├── mod.rs
    │   ├── jwt.rs              # Token generation + validation
    │   ├── middleware.rs        # Axum auth extractor middleware
    │   └── password.rs         # argon2 hashing
    ├── models/
    │   ├── mod.rs
    │   ├── organization.rs
    │   ├── user.rs
    │   ├── device.rs
    │   ├── assignment.rs
    │   ├── claim.rs
    │   ├── telemetry.rs
    │   └── audit.rs
    ├── ws/
    │   ├── mod.rs
    │   ├── handler.rs          # WebSocket upgrade + per-connection loop
    │   ├── registry.rs         # Track connected device sessions
    │   └── commands.rs         # Command routing via Redis pub/sub
    ├── api/
    │   ├── mod.rs              # Router assembly
    │   ├── auth.rs             # Login, refresh, me
    │   ├── organizations.rs    # Org endpoints
    │   ├── users.rs            # User CRUD
    │   ├── devices.rs          # Device list, detail, claim-to-org
    │   ├── assignments.rs      # Device ↔ user assignment
    │   ├── control.rs          # Claim/release, send command
    │   └── telemetry.rs        # Live + history + stream
    └── jobs/
        ├── mod.rs
        ├── claim_expiry.rs     # Expire stale control claims
        ├── telemetry_prune.rs  # Delete telemetry older than TTL
        └── device_offline.rs   # Mark devices offline if no heartbeat
```

### Config (ingest.toml)
```toml
[server]
host = "0.0.0.0"
port = 8080
# WebSocket endpoint path
ws_path = "/devices"

[database]
url = "postgres://ingest:password@localhost:5432/lgl_ingest"
max_connections = 20

[redis]
url = "redis://localhost:6379"

[auth]
jwt_secret = "change-me-in-production"
# JWT expiry for device tokens (seconds)
device_token_ttl = 3600
# JWT expiry for user tokens (seconds)
user_token_ttl = 3600

[control]
# Control claim auto-expiry (seconds)
claim_ttl = 300
# How often to check for expired claims (seconds)
claim_check_interval = 30

[telemetry]
# How long to keep telemetry history (hours)
history_ttl_hours = 24
# How often to prune old telemetry (seconds)
prune_interval = 300
# Insert to DB every Nth telemetry message (to reduce write volume)
db_sample_rate = 5

[limits]
# Max devices per organization
max_devices_per_org = 100
# Max users per organization
max_users_per_org = 50
```
---
## 9. Key Implementation Details
### 9.1 WebSocket Handler
The WebSocket handler at `/devices` manages the full device lifecycle:
```rust
// Pseudocode for the WebSocket connection handler
async fn handle_device_ws(ws: WebSocket, state: AppState) {
    let (mut tx, mut rx) = ws.split();
    // 1. Wait for registration message (10s timeout)
    let register_msg = timeout(10s, rx.next()).await;
    let device = register_or_update_device(register_msg, &state.db).await;
    // 2. Send register response with JWT
    let token = generate_device_jwt(&device);
    tx.send(json!({ "msg_type": "register_response", "device_id": device.device_id, "auth_token": token }));
    // 3. Mark device online
    update_device_status(&device, "online").await;
    state.ws_registry.insert(device.id, tx_handle);
    // 4. Subscribe to command channel
    let mut cmd_sub = state.redis.subscribe(format!("commands:{}", device.id));
    // 5. Main loop
    loop {
        select! {
            // Device sends telemetry
            msg = rx.next() => handle_telemetry(msg, &device, &state),
            // Portal sends command via Redis
            cmd = cmd_sub.next() => forward_command_to_device(cmd, &mut tx),
            // Ping/keepalive every 30s
            _ = ping_interval.tick() => tx.send(Ping),
            // Token refresh before expiry
            _ = token_refresh_timer.tick() => {
                let new_token = generate_device_jwt(&device);
                tx.send(json!({ "msg_type": "register_response", ... }));
            }
        }
    }
    // Cleanup on disconnect
    state.ws_registry.remove(device.id);
    update_device_status(&device, "offline").await;
}
```
### 9.2 Command Routing
Commands flow: **Portal REST API → Redis Pub/Sub → WebSocket handler → Device**
```
POST /api/v1/devices/:id/control/command
  → Validate user has control claim
  → Validate command payload
  → Publish to Redis channel "commands:{device_uuid}"
  → WS handler receives from Redis subscription
  → Forward JSON to device over WebSocket
  → Audit log entry
```
This decouples the REST API from WebSocket connections, and supports horizontal scaling (multiple server instances, each handling a subset of WS connections).

### 9.3 Telemetry Flow
```
Device sends telemetry over WS
  → WS handler parses JSON
  → Update Redis: SET telemetry:{device_uuid} (TTL 30s)
  → Update devices table: last_state, last_seen_at
  → Every 5th message: INSERT into telemetry table
  → If portal user is streaming: forward via their WS connection
```
### 9.4 Control Claim Mutex
```rust
// Claim logic
async fn claim_control(device_id: Uuid, user_id: Uuid, db: &PgPool) -> Result<Claim> {
    // Check for existing claim
    let existing = sqlx::query_as!(Claim, "SELECT * FROM control_claims WHERE device_id = $1", device_id)
        .fetch_optional(db).await?;
    match existing {
        Some(claim) if claim.expires_at > now() && claim.user_id != user_id => {
            return Err(Error::DeviceClaimed { by: claim.user_id, expires: claim.expires_at });
        }
        Some(claim) if claim.user_id == user_id => {
            // Refresh expiry
            sqlx::query!("UPDATE control_claims SET expires_at = $1 WHERE id = $2",
                now() + Duration::minutes(5), claim.id).execute(db).await?;
            return Ok(claim);
        }
        _ => {
            // Delete expired claim if any, insert new
            sqlx::query!("DELETE FROM control_claims WHERE device_id = $1", device_id)
                .execute(db).await?;
            let claim = sqlx::query_as!(Claim,
                "INSERT INTO control_claims (device_id, user_id, expires_at) VALUES ($1, $2, $3) RETURNING *",
                device_id, user_id, now() + Duration::minutes(5))
                .fetch_one(db).await?;
            return Ok(claim);
        }
    }
}
```
### 9.5 Background Jobs
Run as tokio tasks within the same process:
1. **Claim expiry** (every 30s): `DELETE FROM control_claims WHERE expires_at < now()`
2. **Telemetry prune** (every 5m): `DELETE FROM telemetry WHERE created_at < now() - interval '24 hours'`
3. **Device offline detection** (every 30s): `UPDATE devices SET status = 'offline' WHERE status = 'online' AND last_seen_at < now() - interval '60 seconds'`

---
## 10. Deployment
### Docker
```dockerfile
FROM rust:1.82-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/lgl-ingest /usr/local/bin/
COPY config/ingest.example.toml /etc/lgl-ingest/ingest.toml
EXPOSE 8080
CMD ["lgl-ingest", "/etc/lgl-ingest/ingest.toml"]
```
### docker-compose.yml (Development)
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: lgl_ingest
      POSTGRES_USER: ingest
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  ingest:
    build: .
    ports:
      - "8080:8080"
    environment:
      DATABASE_URL: postgres://ingest:password@postgres:5432/lgl_ingest
      REDIS_URL: redis://redis:6379
      JWT_SECRET: dev-secret-change-in-prod
    depends_on:
      - postgres
      - redis
volumes:
  pgdata:
```
### Health Check
```
GET /health
→ 200 { "status": "ok", "db": "connected", "redis": "connected", "uptime_secs": 1234 }
```
---
## 11. Testing Strategy
### Unit Tests
- JWT generation and validation
- Command validation (bitrate bounds, pipeline whitelist)
- Telemetry parsing and serialization
- Claim mutex logic (acquire, refresh, expire, conflict)
- Role-based access control checks

### Integration Tests
- Full WebSocket registration flow (connect → register → receive response)
- Telemetry ingestion (send telemetry, verify Redis + DB)
- Command routing (REST → Redis → WS delivery)
- Auth flow (login → get token → access protected endpoint)
- Organization isolation (user A cannot see user B's devices)
- Control claim lifecycle (claim → send commands → release → another user claims)

### Test Infrastructure
Use `testcontainers-rs` for spinning up Postgres and Redis in integration tests:
```rust
#[tokio::test]
async fn test_device_registration() {
    let pg = testcontainers::Postgres::default().start().await;
    let redis = testcontainers::Redis::default().start().await;
    let app = setup_test_app(pg.url(), redis.url()).await;
    // Connect WebSocket and send registration
    let ws = connect_ws(&app).await;
    ws.send(json!({ "msg_type": "register", "device_id": "abc123...", ... }));
    // Verify response
    let response = ws.recv().await;
    assert_eq!(response["msg_type"], "register_response");
    assert!(!response["auth_token"].as_str().unwrap().is_empty());
    // Verify device in DB
    let device = sqlx::query!("SELECT * FROM devices WHERE device_id = 'abc123...'")
        .fetch_one(&app.db).await.unwrap();
    assert_eq!(device.status, "online");
}
```
---
## 12. Seed Data / Bootstrap
On first run, the system needs an initial admin user. Use a CLI command:
```bash
lgl-ingest seed --org "Acme Broadcasting" --admin-email admin@example.com --admin-password changeme
```
This creates the organization and the first admin user. All subsequent users are created via the REST API.

---
## 13. Future Considerations (Not in Scope for V1)
These are noted for awareness but should NOT be implemented in the initial build:
- **WebRTC preview** — low-latency video preview in the portal (requires media server integration)
- **Device firmware updates** — OTA push via the command channel
- **Multi-region** — geo-distributed WebSocket gateways with shared Postgres (CockroachDB or read replicas)
- **OAuth / SSO** — replace email/password with Google/GitHub OAuth
- **Webhook integrations** — POST telemetry events to external URLs
- **Time-series database** — migrate telemetry from Postgres to TimescaleDB or InfluxDB for long-term retention
- **gRPC between services** — if Ingest grows into multiple microservices

---
## 14. Wire Format Quick Reference
### Device → Server
| msg_type | Fields | Notes |
|----------|--------|-------|
| `register` | `device_id` (64 hex), `hardware_id`, `hostname`, `version` | Once per connection |
| `telemetry` | `ts`, `state`, `paths[]`, `encoder{}`, `uptime_secs` | Every ~500ms |

### Server → Device
| msg_type | Fields | Notes |
|----------|--------|-------|
| `register_response` | `device_id`, `auth_token` (JWT) | After registration, and for token refresh |
| `command` | `cmd` + command-specific fields | See command table below |

### Commands
| cmd | Extra Fields | Constraints |
|-----|-------------|-------------|
| `start` | — | — |
| `stop` | — | — |
| `set_bitrate_range` | `min_kbps`, `max_kbps` | min <= max, max <= 100000 |
| `set_pipeline` | `variant` | One of: `h264_v4l2_usb`, `h265_v4l2_usb`, `h264_qsv` |

### Device States
`idle` → `starting` → `streaming` → `stopping` → `idle`
                                   ↘ `error` ↗

---
## 15. Success Criteria
The LGL-Ingest service is complete when:
1. A real LGL Uplink device can connect, register, and push telemetry
2. The portal REST API supports the full CRUD lifecycle (orgs, users, devices, assignments)
3. An operator can claim control and send start/stop/bitrate/pipeline commands that reach the device
4. Telemetry is visible in real-time and with historical queries
5. Organization isolation is enforced — users cannot see or control devices outside their org
6. The service runs in Docker with Postgres and Redis
7. All unit and integration tests pass
8. An admin can seed the first org and user from the CLI
