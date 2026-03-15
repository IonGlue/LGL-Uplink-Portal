import type { Sql } from 'postgres'
import type Redis from 'ioredis'
import type { WsRegistry } from './ws/registry.js'

export interface Config {
  server: {
    host: string
    port: number
    ws_path: string
    trust_cf_connecting_ip: boolean
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
  control: {
    claim_ttl: number
    claim_check_interval: number
  }
  telemetry: {
    history_ttl_hours: number
    prune_interval: number
    db_sample_rate: number
  }
  limits: {
    max_devices_per_org: number
    max_users_per_org: number
  }
}

export interface AppState {
  db: Sql
  redis: Redis
  config: Config
  wsRegistry: WsRegistry
  startedAt: number // Date.now()
}

export interface UserClaims {
  sub: string
  org_id: string
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
export interface Organization {
  id: string
  name: string
  slug: string
  created_at: Date
  updated_at: Date
}

export interface OrgWithCounts {
  id: string
  name: string
  slug: string
  device_count: number
  user_count: number
}

export interface User {
  id: string
  email: string
  password_hash: string
  display_name: string
  role: string
  org_id: string
  created_at: Date
  updated_at: Date
}

export interface UserPublic {
  id: string
  email: string
  display_name: string
  role: string
  org_id: string
}

export interface Device {
  id: string
  device_id: string
  hardware_id: string
  hostname: string
  nickname: string | null
  version: string
  org_id: string | null
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
  // Verification fields (RFC 8628-style physical presence check)
  verification_code: string | null
  verification_state: string   // 'unverified' | 'verified'
  verified_at: Date | null
  verified_by: string | null
}

export interface Assignment {
  id: string
  device_id: string
  user_id: string
  assigned_at: Date
  assigned_by: string | null
}

export interface ControlClaim {
  id: string
  device_id: string
  user_id: string
  claimed_at: Date
  expires_at: Date
}

export interface TelemetryRecord {
  id: number
  device_id: string
  ts: Date
  state: string
  payload: any
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

export interface Destination {
  id: string
  org_id: string
  name: string
  srt_host: string
  srt_port: number
  srt_latency_ms: number
  srt_passphrase: string | null
  description: string
  created_by: string | null
  created_at: Date
  updated_at: Date
}

export interface AuditEntry {
  id: number
  actor_type: string
  actor_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  details: any
  created_at: Date
}

// Hono env type
export type AppEnv = {
  Variables: {
    state: AppState
    user: UserClaims
  }
}
