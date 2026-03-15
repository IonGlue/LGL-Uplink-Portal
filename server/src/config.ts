import { readFileSync } from 'fs'
import { parse } from 'smol-toml'
import type { Config } from './types.js'

export function loadConfig(path: string): Config {
  const content = readFileSync(path, 'utf-8')
  const config = parse(content) as unknown as Config

  // Environment variable overrides
  if (process.env.DATABASE_URL) config.database.url = process.env.DATABASE_URL
  if (process.env.REDIS_URL) config.redis.url = process.env.REDIS_URL
  if (process.env.JWT_SECRET) config.auth.jwt_secret = process.env.JWT_SECRET
  if (process.env.SUPERVISOR_API_URL) config.supervisor.api_url = process.env.SUPERVISOR_API_URL

  return config
}
