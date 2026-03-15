import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { cors } from 'hono/cors'
import Redis from 'ioredis'
import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db.js'
import { WsRegistry } from './ws/registry.js'
import { handleDeviceConnection } from './ws/handler.js'
import { errorHandler } from './error.js'
import type { AppEnv, AppState } from './types.js'
import { startJobs } from './jobs/index.js'

import authRouter from './api/auth.js'
import usersRouter from './api/users.js'
import devicesRouter from './api/devices.js'
import sourcesRouter from './api/sources.js'
import destinationsRouter from './api/destinations.js'
import routingRouter from './api/routing.js'
import systemRouter from './api/system.js'

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
