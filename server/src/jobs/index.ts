import type { AppState } from '../types.js'
import { IngestClient } from '../ingest/client.js'

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

  // Sync supervisor status back to Postgres every 8 seconds.
  // The supervisor tracks live process state in memory; the DB is the source
  // of truth for the UI.  Without this sync the UI always shows stale 'idle'.
  const statusSyncInterval = setInterval(
    () => syncSupervisorStatus(state).catch((e) => console.error('status sync error:', e)),
    8_000,
  )

  return function stopJobs() {
    clearInterval(offlineInterval)
    clearInterval(pruneInterval)
    clearInterval(statusSyncInterval)
  }
}

/**
 * Pull live source/dest status + PIDs from the supervisor and write them
 * back to Postgres so the UI reflects reality.
 */
async function syncSupervisorStatus(state: AppState) {
  const { db, config } = state
  const ingest = new IngestClient(config.supervisor.api_url)

  const [sourcesRes, destsRes] = await Promise.all([
    ingest.listSources(),
    ingest.listDests(),
  ])

  for (const s of sourcesRes.sources ?? []) {
    await db`
      UPDATE sources
      SET status = ${s.status}, process_pid = ${s.process_pid ?? null},
          internal_port = COALESCE(${s.internal_port ?? null}, internal_port)
      WHERE id = ${s.id}
    `.catch(() => {})
  }

  for (const d of destsRes.dests ?? []) {
    await db`
      UPDATE destinations
      SET status = ${d.status}, process_pid = ${d.process_pid ?? null}
      WHERE id = ${d.id}
    `.catch(() => {})
  }
}
