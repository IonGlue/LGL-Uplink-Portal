# LGL Uplink Portal

Server-side platform for the LGL Uplink bonded encoder system. Accepts persistent WebSocket connections from field encoder devices, stores real-time telemetry, routes commands from authenticated portal users, and provides a REST API for the web dashboard.

See [SPEC.md](./SPEC.md) for the full build specification.

## Tech Stack

- **Rust** + **Axum** — async web framework with WebSocket support
- **PostgreSQL** — relational store (devices, orgs, users, assignments, audit)
- **Redis** — live telemetry cache, pub/sub command routing, WS session tracking
- **sqlx** — compile-time checked SQL queries
- **JWT** — device and user authentication tokens

## Quick Start (Development)

```bash
# Start Postgres + Redis + the Uplink Portal service
docker compose up

# Or run locally against the docker infra
docker compose up postgres redis -d
cargo run -- config/uplink.example.toml

# Seed the first org and admin user
cargo run -- seed --org "My Org" --admin-email admin@example.com --admin-password changeme
```

## Project Structure

```
src/
├── main.rs          # Entry point, router, health check, seed CLI
├── config.rs        # TOML config loading with env overrides
├── error.rs         # Unified error type with Axum IntoResponse
├── db.rs            # sqlx pool + migrations
├── auth/            # JWT generation/validation, Axum extractors, argon2
├── models/          # Database models (org, user, device, claim, telemetry, audit)
├── ws/              # WebSocket gateway (device handler, registry, command routing)
├── api/             # REST API handlers (auth, devices, users, control, telemetry)
└── jobs/            # Background tokio tasks (claim expiry, telemetry prune, offline detection)
migrations/          # sqlx SQL migrations (001–007)
config/              # Example TOML config
```

## API Overview

- `POST /api/v1/auth/login` — get a user JWT
- `GET  /api/v1/devices` — list org devices
- `POST /api/v1/devices/:id/control/claim` — acquire exclusive device control
- `POST /api/v1/devices/:id/control/command` — send start/stop/bitrate/pipeline command
- `GET  /api/v1/devices/:id/telemetry/live` — latest telemetry snapshot
- `GET  /api/v1/devices/:id/telemetry/stream` — WebSocket real-time telemetry feed
- `GET  /health` — service health check

## WebSocket Device Protocol

Devices connect to `wss://<host>/devices` and exchange JSON messages:

- Device → Server: `register`, `telemetry`
- Server → Device: `register_response` (with JWT), `command`

See [SPEC.md §5](./SPEC.md#5-websocket-gateway--device-protocol) for the exact wire format.

## Configuration

Copy `config/uplink.example.toml` and adjust. Environment variables override config file values:

| Env Var | Config Key |
|---------|-----------|
| `DATABASE_URL` | `database.url` |
| `REDIS_URL` | `redis.url` |
| `JWT_SECRET` | `auth.jwt_secret` |
