import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware } from '../auth/middleware.js'

const telemetry = new Hono<AppEnv>()

telemetry.use(authMiddleware)

telemetry.get('/:id/telemetry/live', async (c) => {
  const { state, user } = c.var
  const deviceId = c.req.param('id')

  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}`
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  const key = `telemetry:${deviceId}`
  const raw = await state.redis.get(key)

  if (!raw) {
    console.warn(`live telemetry not in Redis cache for device ${deviceId}`)
    throw AppError.notFound()
  }

  const val = JSON.parse(raw)
  // Compute age_ms
  if (val.ts) {
    const then = new Date(val.ts * 1000)
    val.age_ms = Math.max(0, Date.now() - then.getTime())
  }

  return c.json(val)
})

telemetry.get('/:id/telemetry/history', async (c) => {
  const { state, user } = c.var
  const deviceId = c.req.param('id')

  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}`
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  const toStr = c.req.query('to')
  const fromStr = c.req.query('from')
  const to = toStr ? new Date(toStr) : new Date()
  const from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 60 * 60 * 1000) // 1 hour default

  // Enforce max range of 24 hours
  if (to.getTime() - from.getTime() > 24 * 60 * 60 * 1000) {
    throw AppError.validation('max range is 24 hours')
  }

  const records = await state.db`
    SELECT id, device_id, ts, state, payload, created_at
    FROM telemetry
    WHERE device_id = ${deviceId} AND ts >= ${from} AND ts <= ${to}
    ORDER BY ts
  `

  return c.json({ records, from: from.toISOString(), to: to.toISOString() })
})

export default telemetry
