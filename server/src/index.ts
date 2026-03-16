import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { cors } from 'hono/cors'
import { Redis } from 'ioredis'
import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db.js'
import { WsRegistry } from './ws/registry.js'
import { handleDeviceConnection } from './ws/handler.js'
import { errorHandler } from './error.js'
import type { AppEnv, AppState } from './types.js'
import { startJobs } from './jobs/index.js'
import { IngestClient } from './ingest/client.js'

import authRouter from './api/auth.js'
import usersRouter from './api/users.js'
import devicesRouter from './api/devices.js'
import sourcesRouter from './api/sources.js'
import destinationsRouter from './api/destinations.js'
import routingRouter from './api/routing.js'
import systemRouter from './api/system.js'
import syncRouter from './api/sync.js'

const configPath = process.env.CONFIG_PATH ?? 'config/ingest.toml'
const config = loadConfig(configPath)

const db = createDb(config.database.url, config.database.max_connections)
await runMigrations(db)

const redis = new Redis(config.redis.url, { lazyConnect: true })
await redis.connect()

const wsRegistry = new WsRegistry()
const startedAt = Date.now()

const state: AppState = { db, redis, config, wsRegistry, startedAt }

const app = new Hono<AppEnv>()

const corsOrigin = process.env.CORS_ORIGIN || '*'
app.use('*', cors({ origin: corsOrigin, allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }))

// Inject state into every request
app.use('*', async (c, next) => {
  c.set('state', state)
  await next()
})

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }))

// REST API routes
app.route('/api/auth', authRouter)
app.route('/api/users', usersRouter)
app.route('/api/devices', devicesRouter)
app.route('/api/sources', sourcesRouter)
app.route('/api/destinations', destinationsRouter)
app.route('/api/routing', routingRouter)
app.route('/api/system', systemRouter)
app.route('/api/sync-groups', syncRouter)

// Serve frontend static files and SPA fallback
app.use('/*', serveStatic({ root: './public' }))
app.get('/*', serveStatic({ path: 'index.html', root: './public' }))

// Error handler
app.onError((err, c) => errorHandler(err, c))

// WebSocket upgrade for device connections
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.get(
  config.server.ws_path,
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      // ws is a hono WSContext — pass the raw socket to our handler
      const rawWs = (ws as unknown as { raw: import('ws').WebSocket }).raw
      handleDeviceConnection(rawWs, state).catch((e) =>
        console.error('device connection error:', e),
      )
    },
    onError(error) {
      console.error('ws error:', error)
    },
  })),
)

// Hydrate the supervisor with persisted state so sources/dests/routes that
// existed before a restart are immediately known to the supervisor process.
hydrateIngestSupervisor(state).catch((e) => console.error('supervisor hydration error:', e))

// Background jobs
const stopJobs = startJobs(state)

// Graceful shutdown
const shutdown = async () => {
  console.log('shutting down...')
  stopJobs()
  await db.end()
  await redis.quit()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const server = serve(
  { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
  (info) => console.log(`LGL Ingest server listening on ${info.address}:${info.port}`),
)

injectWebSocket(server)

/**
 * Re-register all persisted sources, destinations, and routes with the
 * supervisor process.  Called once at startup so that a supervisor restart
 * (or server restart) doesn't leave the supervisor with an empty routing
 * table while the DB still has resources defined.
 */
async function hydrateIngestSupervisor(appState: AppState) {
  const { db, config: cfg } = appState
  const ingest = new IngestClient(cfg.supervisor.api_url)

  const [sources, dests, routes] = await Promise.all([
    db`SELECT id, name, source_type, config, internal_port, position_x, position_y
       FROM sources WHERE source_type != 'placeholder'`,
    db`SELECT id, name, dest_type, config, position_x, position_y
       FROM destinations WHERE dest_type != 'placeholder'`,
    db`SELECT id, source_id, dest_id FROM routing WHERE enabled = true`,
  ])

  // Register sources first (supervisor allocates internal ports)
  for (const s of sources) {
    try {
      const res = await ingest.createSource({
        id: s.id, name: s.name, source_type: s.source_type,
        config: s.config, position_x: s.position_x, position_y: s.position_y,
      }) as { internal_port?: number }
      if (res?.internal_port != null && res.internal_port !== s.internal_port) {
        await db`UPDATE sources SET internal_port = ${res.internal_port} WHERE id = ${s.id}`
      }
    } catch { /* supervisor may already know about this source */ }
  }

  for (const d of dests) {
    try {
      await ingest.createDest({
        id: d.id, name: d.name, dest_type: d.dest_type,
        config: d.config, position_x: d.position_x, position_y: d.position_y,
      })
    } catch { /* supervisor may already know about this dest */ }
  }

  for (const r of routes) {
    try {
      await ingest.createRoute({ source_id: r.source_id, dest_id: r.dest_id })
    } catch { /* route may already exist */ }
  }

  // Re-register active sync groups, restoring their persisted aligned ports.
  const activeSyncGroups = await db`
    SELECT sg.id, sg.name, sg.target_delay_ms, sg.max_offset_ms,
           COALESCE(json_agg(sgm.source_id) FILTER (WHERE sgm.source_id IS NOT NULL), '[]') AS source_ids,
           COALESCE(
             json_object_agg(sgp.source_id, sgp.aligned_port) FILTER (WHERE sgp.source_id IS NOT NULL),
             '{}'
           ) AS aligned_ports
    FROM sync_groups sg
    LEFT JOIN sync_group_members sgm ON sgm.sync_group_id = sg.id
    LEFT JOIN sync_group_ports sgp ON sgp.sync_group_id = sg.id
    WHERE sg.status = 'active'
    GROUP BY sg.id
  `
  for (const g of activeSyncGroups) {
    try {
      await ingest.createSyncGroup({
        id: g.id, name: g.name,
        target_delay_ms: g.target_delay_ms, max_offset_ms: g.max_offset_ms,
        source_ids: g.source_ids,
      })
      // Restore the supervisor with the known aligned ports so destinations
      // can reconnect to the correct ports after a restart.
      if (Object.keys(g.aligned_ports ?? {}).length > 0) {
        await ingest.updateSyncGroup(g.id, { aligned_ports: g.aligned_ports })
      }
    } catch { /* supervisor may already know about it */ }
  }

  console.log(`supervisor hydrated: ${sources.length} sources, ${dests.length} dests, ${routes.length} routes, ${activeSyncGroups.length} active sync groups`)
}
