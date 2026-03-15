import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireAdmin, requireOperatorOrAbove } from '../auth/middleware.js'
import { validateCommand, toWireJson } from '../ws/commands.js'

const app = new Hono<AppEnv>()

app.use('*', authMiddleware)

app.get('/', async (c) => {
  const devices = await c.var.state.db`
    SELECT id, device_id, hardware_id, hostname, nickname, version, status, last_state,
           last_seen_at, registered_at, updated_at, enrollment_state, enrolled_at,
           archived, verification_state, verified_at
    FROM devices
    ORDER BY registered_at DESC
  `
  return c.json(devices)
})

app.get('/:id', async (c) => {
  const [device] = await c.var.state.db`
    SELECT id, device_id, hardware_id, hostname, nickname, version, status, last_state,
           last_seen_at, registered_at, updated_at, enrollment_state, enrolled_at,
           archived, verification_state, verified_at
    FROM devices WHERE id = ${c.req.param('id')}
  `
  if (!device) throw AppError.notFound()
  return c.json(device)
})

app.patch('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  const { db } = c.var.state

  const [existing] = await db`SELECT id FROM devices WHERE id = ${id}`
  if (!existing) throw AppError.notFound()

  if (body.nickname != null) {
    await db`UPDATE devices SET nickname = ${body.nickname}, updated_at = now() WHERE id = ${id}`
  }
  if (body.archived != null) {
    await db`UPDATE devices SET archived = ${!!body.archived}, updated_at = now() WHERE id = ${id}`
  }

  const [updated] = await db`
    SELECT id, device_id, hostname, nickname, version, status, enrollment_state, archived
    FROM devices WHERE id = ${id}
  `
  return c.json(updated)
})

// Enrollment actions
app.post('/:id/enroll', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => ({}))
  const action = body.action
  if (!['approve', 'reject'].includes(action)) {
    throw AppError.validation('action must be approve or reject')
  }

  const { db, redis } = c.var.state
  const id = c.req.param('id')
  const [device] = await db`SELECT id, enrollment_state FROM devices WHERE id = ${id}`
  if (!device) throw AppError.notFound()
  if (device.enrollment_state !== 'pending') {
    throw AppError.validation('device is not in pending enrollment state')
  }

  if (action === 'approve') {
    await db`
      UPDATE devices SET enrollment_state = 'enrolled', enrolled_at = now(), enrolled_by = ${c.var.user.sub}, updated_at = now()
      WHERE id = ${id}
    `
    await redis.publish(`enrollment:${id}`, 'approved')
  } else {
    await db`UPDATE devices SET enrollment_state = 'rejected', updated_at = now() WHERE id = ${id}`
    await redis.publish(`enrollment:${id}`, 'rejected')
  }

  await db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${c.var.user.sub}, ${'device.enroll.' + action}, 'device', ${id})
  `.catch(() => {})

  return c.json({ ok: true })
})

// Verification actions
app.post('/:id/verify', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const { db, redis } = c.var.state
  const id = c.req.param('id')

  const [device] = await db`SELECT id, verification_state FROM devices WHERE id = ${id}`
  if (!device) throw AppError.notFound()

  await db`
    UPDATE devices SET verification_state = 'verified', verified_at = now(), verified_by = ${c.var.user.sub}, updated_at = now()
    WHERE id = ${id}
  `
  await redis.publish(`verification:${id}`, 'approved')

  await db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${c.var.user.sub}, 'device.verify', 'device', ${id})
  `.catch(() => {})

  return c.json({ ok: true })
})

// Send a command to a connected device
app.post('/:id/command', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => null)
  if (!body) throw AppError.validation('body required')

  validateCommand(body)

  const { db, redis, wsRegistry } = c.var.state
  const id = c.req.param('id')

  const [device] = await db`SELECT id FROM devices WHERE id = ${id}`
  if (!device) throw AppError.notFound()

  const payload = JSON.stringify(toWireJson(body))
  const sent = wsRegistry.send(id, payload)
  if (!sent) {
    // Device not directly connected — publish via Redis for multi-instance setups
    await redis.publish(`commands:${id}`, payload)
  }

  await db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${c.var.user.sub}, 'device.command', 'device', ${id}, ${JSON.stringify(body)})
  `.catch(() => {})

  return c.json({ ok: true })
})

// Latest telemetry from Redis
app.get('/:id/telemetry', async (c) => {
  const { db, redis } = c.var.state
  const id = c.req.param('id')
  const [device] = await db`SELECT id FROM devices WHERE id = ${id}`
  if (!device) throw AppError.notFound()

  const raw = await redis.get(`telemetry:${id}`)
  if (!raw) return c.json(null)
  return c.json(JSON.parse(raw))
})

// Unenroll / reset
app.post('/:id/unenroll', async (c) => {
  requireAdmin(c.var.user)
  const { db } = c.var.state
  const id = c.req.param('id')
  const [device] = await db`SELECT id FROM devices WHERE id = ${id}`
  if (!device) throw AppError.notFound()

  const code = id.slice(0, 12)
  await db`
    UPDATE devices SET
      enrollment_state = 'pending',
      enrollment_code = ${code},
      enrolled_at = null,
      enrolled_by = null,
      updated_at = now()
    WHERE id = ${id}
  `
  return c.json({ ok: true })
})

export default app
