import type { Sql } from 'postgres'
import type { Config } from '../types.js'

export function startJobs(db: Sql, config: Config) {
  // Claim expiry job
  setInterval(async () => {
    try {
      const result = await db`DELETE FROM control_claims WHERE expires_at < now()`
      if (result.count > 0) {
        console.log(`claim expiry: deleted ${result.count} expired claims`)
      }
    } catch (e) {
      console.error('claim expiry job error:', e)
    }
  }, config.control.claim_check_interval * 1000)

  // Device offline job (30s interval)
  setInterval(async () => {
    try {
      const result = await db`
        UPDATE devices SET status = 'offline'
        WHERE status = 'online'
          AND last_seen_at < now() - interval '60 seconds'
      `
      if (result.count > 0) {
        console.log(`device offline: marked ${result.count} devices offline`)
      }
    } catch (e) {
      console.error('device offline job error:', e)
    }
  }, 30_000)

  // Telemetry prune job
  setInterval(async () => {
    try {
      const ttl = `${config.telemetry.history_ttl_hours} hours`
      const result = await db`
        DELETE FROM telemetry WHERE created_at < now() - ${ttl}::interval
      `
      if (result.count > 0) {
        console.log(`telemetry prune: deleted ${result.count} old records`)
      }
    } catch (e) {
      console.error('telemetry prune job error:', e)
    }
  }, config.telemetry.prune_interval * 1000)

  console.log('background jobs started')
}
