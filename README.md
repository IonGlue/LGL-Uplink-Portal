# LGL Ingest

A visual stream routing platform — like a broadcast patchbay. Encoders, custom SRT/RTMP feeds, and test patterns appear on the left; RTMP destinations, SRT re-streams, HLS outputs, and file recorders appear on the right. Drag a line between them to route.

```
SOURCES                          DESTINATIONS
┌─────────────────┐              ┌──────────────────┐
│ encoder-cam1    │─────────────▶│ YouTube RTMP     │
│ (SRTLA relay)   │    ╮         └──────────────────┘
└─────────────────┘    ├────────▶┌──────────────────┐
                        │        │ Recorder-01      │
┌─────────────────┐    │        └──────────────────┘
│ custom-srt-01   │    │
│ (SRT listener)  │    │        ┌──────────────────┐
└─────────────────┘    │        │ HLS stream       │
                        │        └──────────────────┘
┌─────────────────┐    │
│ test-pattern    │────╯
└─────────────────┘
```

Each source and destination runs as an isolated OS process. A crash in one destination doesn't affect any other stream.

---

## Architecture

```
ingest-supervisor  (Rust)   — process manager, routing table, port pool
  ├── ingest-source         — one worker per active source
  └── ingest-dest           — one worker per active routing

server/            (TypeScript / Hono) — REST API, WebSocket for encoders, auth
frontend/          (React / React Flow) — patchbay UI
```

Internal routing uses SRT on localhost. Each source worker listens on an internal port (10000–11000); destination workers connect as callers. If a destination crashes it restarts and reconnects; the source keeps streaming uninterrupted.

### Source types

| Type | Description |
|------|-------------|
| `encoder` | LGL-Uplink encoder connecting via SRTLA bonding |
| `srt_listen` | Accept an incoming SRT push on a custom port |
| `srt_pull` | Pull from a remote SRT URL |
| `rtmp_pull` | Pull from an RTMP URL |
| `test_pattern` | SMPTE/colour-bar test signal (GStreamer `videotestsrc`) |
| `placeholder` | Named slot — pre-route before hardware arrives |

### Destination types

| Type | Description |
|------|-------------|
| `rtmp` | Push to an RTMP ingest (YouTube, Twitch, custom) |
| `srt_push` | Push to a remote SRT listener |
| `hls` | Write HLS segments to disk |
| `recorder` | Write MPEG-TS segments to disk |
| `lgl_ingest` | Forward to another LGL Ingest instance |
| `placeholder` | Named slot |

---

## Quick start

### Docker (recommended)

```bash
# 1. Copy and edit config
cp config/ingest.example.toml config/ingest.toml
# Edit: jwt_secret, database URL if using an external Postgres

# 2. Build and start
docker compose up -d --build

# 3. Verify
curl http://localhost:3000/api/system/health   # → {"ok":true}
open http://localhost:8080                      # patchbay UI
```

Services:

| Service | Port | Notes |
|---------|------|-------|
| Frontend (nginx) | 8080 | Patchbay UI |
| Server (Hono) | 3000 | REST API + WebSocket |
| Supervisor (Axum) | 9000 | Local API — not exposed externally |
| Postgres | 5432 | |
| Redis | 6379 | |

The supervisor uses `network_mode: host` so it can freely bind to SRT ports (5001 default SRT input, 10000–11000 internal routing, plus any custom ports configured per source).

### Manual / development

```bash
# Rust workspace
cargo build --release

# TypeScript server
cd server && npm install && npm run build && node dist/index.js

# Frontend dev server
cd frontend && npm install && npm run dev
```

---

## Connecting an encoder

On any LGL-Uplink encoder, set:

```toml
# /etc/uplink/uplink.toml
[device]
ingest_url = "wss://ingest.example.com/ws/device"
```

The encoder connects, appears automatically in the sources panel, and is ready to route. No pre-configuration on the ingest side is required — though you can create a named placeholder first and assign a `device_id` to it so routing is set up before the hardware arrives.

---

## Configuration reference

`config/ingest.toml` (copy from `config/ingest.example.toml`):

```toml
[server]
host = "0.0.0.0"
port = 3000
ws_path = "/ws/device"

[database]
url = "postgres://lgl:lgl@localhost:5432/lgl_ingest"
max_connections = 20

[redis]
url = "redis://localhost:6379"

[auth]
jwt_secret = "change-this"
device_token_ttl = 3600   # seconds
user_token_ttl = 86400

[telemetry]
history_ttl_hours = 48
prune_interval = 3600
db_sample_rate = 10       # store 1 in N telemetry messages

[supervisor]
api_url = "http://127.0.0.1:9000"
```

Supervisor config (`ingest-supervisor/config.toml`):

```toml
api_port = 9000
internal_port_start = 10000
internal_port_end   = 11000
max_restarts        = 5
restart_window_secs = 60
```

---

## Repo layout

```
Cargo.toml                     Rust workspace
Dockerfile.supervisor          Multi-stage Rust build (all three binaries)
docker-compose.yml

ingest-supervisor/             Process manager + routing + local REST API
  src/supervisor.rs            Spawn/monitor/restart workers
  src/routing.rs               Source → destination routing table
  src/port_pool.rs             Internal SRT port allocation
  src/api/mod.rs               Axum routes (sources, dests, routes)

ingest-source/                 Source worker (one per active source)
  src/sources/encoder.rs       SRTLA relay → internal SRT
  src/sources/srt_listen.rs    SRT listener → internal SRT
  src/sources/srt_pull.rs      SRT pull → internal SRT
  src/sources/test_pattern.rs  videotestsrc → internal SRT

ingest-dest/                   Destination worker (one per routing)
  src/destinations/rtmp.rs     internal SRT → rtmpsink
  src/destinations/srt_push.rs internal SRT → srtsink (caller)
  src/destinations/hls.rs      internal SRT → hlssink2
  src/destinations/recorder.rs internal SRT → filesink

server/                        TypeScript control plane
  src/api/                     REST endpoints
  src/ws/handler.ts            Encoder WebSocket handler
  src/ingest/client.ts         HTTP client to supervisor local API

frontend/                      React patchbay UI
  src/components/Patchbay.tsx  React Flow canvas
  src/components/SourceNode.tsx
  src/components/DestNode.tsx
  src/components/RoutingEdge.tsx
  nginx.conf                   SPA + API + WebSocket proxy

migrations/                    PostgreSQL migrations (auto-applied on startup)
config/
  ingest.example.toml
```

---

## User roles

| Role | Permissions |
|------|-------------|
| `admin` | Full access — manage users, approve enrollment |
| `operator` | Create/edit sources, destinations, routing |
| `viewer` | Read-only |

The first user account must be created directly in the database or via the API with a bootstrap token.

---

## Process restart policy

Workers are restarted with exponential backoff (1 s → 2 s → 4 s → max 30 s). After 5 restarts within 60 seconds the worker is marked `error` and the operator must intervene via the UI or API.
