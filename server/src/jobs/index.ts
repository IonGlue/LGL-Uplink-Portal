import type { AppState } from '../types.js'

export function startJobs(state: AppState) {
  const { db, config } = state

  // Mark devices offline if not seen recently
  const offlineInterval = setInterval(async () => {
    try {
      await db`
        UPDATE devices
        SET status = 'offline', updated_at = now()
        WHERE status = 'online'
          AND last_seen_at < now() - INTERVAL '2 minutes'
      `
    } catch (e) {
      console.error('offline sweep error:', e)
    }
  }, 30_000)

  // Prune old telemetry records
  const pruneInterval = setInterval(async () => {
    try {
      const ttlHours = config.telemetry.history_ttl_hours
      const deleted = await db`
        DELETE FROM telemetry WHERE ts < now() - make_interval(hours => ${ttlHours})
      `
      if (deleted.count > 0) {
        console.log(`pruned ${deleted.count} telemetry rows older than ${ttlHours}h`)
      }
    } catch (e) {
      console.error('telemetry prune error:', e)
    }
  }, config.telemetry.prune_interval * 1000)

  return function stopJobs() {
    clearInterval(offlineInterval)
    clearInterval(pruneInterval)
  }
}
