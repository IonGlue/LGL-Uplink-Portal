import { readFileSync } from 'fs'
import { parse } from 'smol-toml'
import type { Config } from './types.js'

function defaultConfig(): Config {
  return {
    server: { host: '0.0.0.0', port: 3000, ws_path: '/ws/device' },
    database: { url: 'postgres://lgl:lgl@localhost:5432/lgl_ingest', max_connections: 20 },
    redis: { url: 'redis://localhost:6379' },
    auth: { jwt_secret: '', device_token_ttl: 3600, user_token_ttl: 86400 },
    telemetry: { history_ttl_hours: 48, prune_interval: 3600, db_sample_rate: 10 },
    supervisor: { api_url: 'http://127.0.0.1:9000' },
  }
}

export function loadConfig(path: string): Config {
  let config: Config
  try {
    const content = readFileSync(path, 'utf-8')
    config = parse(content) as unknown as Config
  } catch {
    // No config file — build from defaults (env var overrides applied below)
    config = defaultConfig()
  }

  // Environment variable overrides
  if (process.env.DATABASE_URL) config.database.url = process.env.DATABASE_URL
  if (process.env.REDIS_URL) config.redis.url = process.env.REDIS_URL
  if (process.env.JWT_SECRET) config.auth.jwt_secret = process.env.JWT_SECRET
  if (process.env.SUPERVISOR_API_URL) config.supervisor.api_url = process.env.SUPERVISOR_API_URL

  return config
}
