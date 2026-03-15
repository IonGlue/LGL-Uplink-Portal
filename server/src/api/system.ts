import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { authMiddleware } from '../auth/middleware.js'
import { IngestClient } from '../ingest/client.js'

const app = new Hono<AppEnv>()

app.get('/health', (c) => c.json({ ok: true }))

app.use('/stats', authMiddleware)
app.get('/stats', async (c) => {
  const { db, config, wsRegistry, startedAt } = c.var.state

  const [deviceCounts] = await db`
    SELECT
      COUNT(*) FILTER (WHERE status = 'online') AS online,
      COUNT(*) FILTER (WHERE enrollment_state = 'pending') AS pending_enrollment,
      COUNT(*) FILTER (WHERE enrollment_state = 'enrolled') AS enrolled
    FROM devices
  `
  const [sourceCounts] = await db`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active') AS active,
      COUNT(*) AS total
    FROM sources
  `
  const [destCounts] = await db`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active') AS active,
      COUNT(*) AS total
    FROM destinations
  `
  const [routeCount] = await db`SELECT COUNT(*) AS total FROM routing WHERE enabled = true`

  let supervisorHealth: unknown = null
  try {
    const ingest = new IngestClient(config.supervisor.api_url)
    supervisorHealth = await ingest.listSources().then(() => ({ ok: true })).catch(() => ({ ok: false }))
  } catch {
    supervisorHealth = { ok: false }
  }

  return c.json({
    uptime_secs: Math.floor((Date.now() - startedAt) / 1000),
    ws_connected: wsRegistry.connectedCount(),
    devices: deviceCounts,
    sources: sourceCounts,
    destinations: destCounts,
    routes: { active: routeCount.total },
    supervisor: supervisorHealth,
  })
})

export default app
