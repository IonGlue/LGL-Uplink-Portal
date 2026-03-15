import type { Sql } from 'postgres'
import type { Redis } from 'ioredis'
import type { WsRegistry } from './ws/registry.js'

export interface Config {
  server: {
    host: string
    port: number
    ws_path: string
  }
  database: {
    url: string
    max_connections: number
  }
  redis: {
    url: string
  }
  auth: {
    jwt_secret: string
    device_token_ttl: number
    user_token_ttl: number
  }
  telemetry: {
    history_ttl_hours: number
    prune_interval: number
    db_sample_rate: number
  }
  supervisor: {
    api_url: string  // e.g. "http://127.0.0.1:9000"
  }
}

export interface AppState {
  db: Sql
  redis: Redis
  config: Config
  wsRegistry: WsRegistry
  startedAt: number
}

export interface UserClaims {
  sub: string
  role: string
  type: string
  exp: number
  iat: number
}

export interface DeviceClaims {
  sub: string
  device_id: string
  type: string
  exp: number
  iat: number
}

// Database row types
export interface User {
  id: string
  email: string
  password_hash: string
  display_name: string
  role: string
  created_at: Date
  updated_at: Date
}

export interface Device {
  id: string
  device_id: string
  hardware_id: string
  hostname: string
  nickname: string | null
  version: string
  status: string
  last_state: string
  last_seen_at: Date | null
  registered_at: Date
  updated_at: Date
  enrollment_state: string
  enrollment_code: string | null
  enrolled_at: Date | null
  enrolled_by: string | null
  archived: boolean
  verification_code: string | null
  verification_state: string
  verified_at: Date | null
  verified_by: string | null
}

export interface Source {
  id: string
  name: string
  source_type: string
  device_id: string | null
  config: Record<string, unknown>
  internal_port: number | null
  status: string
  process_pid: number | null
  position_x: number
  position_y: number
  created_at: Date
}

export interface Destination {
  id: string
  name: string
  dest_type: string
  config: Record<string, unknown>
  status: string
  process_pid: number | null
  position_x: number
  position_y: number
  created_at: Date
}

export interface Route {
  id: string
  source_id: string
  dest_id: string
  enabled: boolean
  created_at: Date
}

export interface TelemetryReport {
  ts: number
  state: string
  paths: PathStats[]
  encoder?: EncoderStats
  uptime_secs: number
}

export interface PathStats {
  interface: string
  bitrate_kbps: number
  rtt_ms: number
  loss_pct: number
  in_flight: number
  window: number
}

export interface EncoderStats {
  pipeline: string
  bitrate_kbps: number
  fps: number
  resolution: string
}

export interface AuditEntry {
  id: number
  actor_type: string
  actor_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  details: unknown
  created_at: Date
}

// Hono env type
export type AppEnv = {
  Variables: {
    state: AppState
    user: UserClaims
  }
}
