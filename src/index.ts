import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import Redis from 'ioredis'
import type { AppEnv, AppState } from './types.js'
import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db.js'
import { errorHandler } from './error.js'
import { WsRegistry } from './ws/registry.js'
import { handleDeviceConnection } from './ws/handler.js'
import { validateUserToken } from './auth/jwt.js'
import { startJobs } from './jobs/index.js'

// API route modules
import authRoutes from './api/auth.js'
import userRoutes from './api/users.js'
import deviceRoutes from './api/devices.js'
import controlRoutes from './api/control.js'
import assignmentRoutes from './api/assignments.js'
import telemetryRoutes from './api/telemetry.js'
import orgRoutes from './api/organizations.js'
import destinationRoutes from './api/destinations.js'

async function main() {
  // Load config
  const configPath = process.argv[2] || 'config/ingest.example.toml'
  const config = loadConfig(configPath)

  // Database
  const db = createDb(config.database.url, config.database.max_connections)
  await runMigrations(db)
  console.log('database migrations complete')

  // Redis
  const redis = new Redis(config.redis.url)
  redis.on('connect', () => console.log('redis connected'))
  redis.on('error', (e) => console.error('redis error:', e))

  // App state
  const appState: AppState = {
    db,
    redis,
    config,
    wsRegistry: new WsRegistry(),
    startedAt: Date.now(),
  }

  // Hono app
  const app = new Hono<AppEnv>()

  // Inject state into all requests
  app.use('*', async (c, next) => {
    c.set('state', appState)
    await next()
  })

  // Error handler
  app.onError(errorHandler)

  // Health endpoint
  app.get('/health', async (c) => {
    let dbOk = false
    let redisOk = false

    try {
      await db`SELECT 1`
      dbOk = true
    } catch {}

    try {
      const pong = await redis.ping()
      redisOk = pong === 'PONG'
    } catch {}

    const uptimeSecs = Math.floor((Date.now() - appState.startedAt) / 1000)

    return c.json({
      status: dbOk && redisOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected' : 'error',
      redis: redisOk ? 'connected' : 'error',
      uptime_secs: uptimeSecs,
    })
  })

  // API routes
  app.route('/api/v1/auth', authRoutes)
  app.route('/api/v1/users', userRoutes)
  app.route('/api/v1/devices', deviceRoutes)
  app.route('/api/v1/devices', controlRoutes)
  app.route('/api/v1/devices', assignmentRoutes)
  app.route('/api/v1/devices', telemetryRoutes)
  app.route('/api/v1/org', orgRoutes)
  app.route('/api/v1/destinations', destinationRoutes)

  // Start HTTP server
  const server = serve({
    fetch: app.fetch,
    hostname: config.server.host,
    port: config.server.port,
  })

  // WebSocket server (attached to the same HTTP server)
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)

    // Device WebSocket endpoint
    if (url.pathname === config.server.ws_path) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleDeviceConnection(ws, appState)
      })
      return
    }

    // Telemetry stream WebSocket endpoint
    const streamMatch = url.pathname.match(
      /^\/api\/v1\/devices\/([0-9a-f-]+)\/telemetry\/stream$/,
    )
    if (streamMatch) {
      const deviceId = streamMatch[1]
      const token = url.searchParams.get('token')
      if (!token) {
        socket.destroy()
        return
      }

      try {
        const claims = await validateUserToken(token, config.auth.jwt_secret)
        const [device] = await db`SELECT * FROM devices WHERE id = ${deviceId}`
        if (!device || device.org_id !== claims.org_id) {
          socket.destroy()
          return
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          handleTelemetryStream(ws, deviceId, appState)
        })
      } catch {
        socket.destroy()
      }
      return
    }

    socket.destroy()
  })

  // Start background jobs
  startJobs(db, config)

  console.log(`listening on ${config.server.host}:${config.server.port}`)
}

// Telemetry stream handler — polls Redis cache and forwards to client
function handleTelemetryStream(ws: import('ws').WebSocket, deviceId: string, state: AppState) {
  let lastTs: number | null = null
  let missCount = 0
  let redisErrCount = 0

  const pollInterval = setInterval(async () => {
    const key = `telemetry:${deviceId}`
    let raw: string | null
    try {
      raw = await state.redis.get(key)
      redisErrCount = 0
    } catch (e) {
      redisErrCount++
      if (redisErrCount === 1 || redisErrCount % 20 === 0) {
        console.warn(`Redis GET failed in telemetry stream for ${deviceId}:`, e)
      }
      if (redisErrCount >= 60) {
        console.warn(`Redis unreachable for 30s, closing telemetry stream for ${deviceId}`)
        cleanup()
        ws.close()
      }
      return
    }

    if (!raw) {
      missCount++
      if (missCount === 1 || missCount % 20 === 0) {
        console.warn(`telemetry stream: Redis key absent for ${deviceId} (miss ${missCount})`)
      }
      return
    }

    missCount = 0
    try {
      const val = JSON.parse(raw)
      const ts = val.ts ?? null
      if (ts !== lastTs) {
        lastTs = ts
        const msg = JSON.stringify({ type: 'telemetry', data: val })
        if (ws.readyState === ws.OPEN) {
          ws.send(msg)
        }
      }
    } catch {
      console.warn(`telemetry stream: failed to parse Redis JSON for ${deviceId}`)
    }
  }, 500)

  function cleanup() {
    clearInterval(pollInterval)
  }

  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

main().catch((e) => {
  console.error('fatal error:', e)
  process.exit(1)
})
