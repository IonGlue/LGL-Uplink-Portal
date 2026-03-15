import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware } from '../auth/middleware.js'
import { validateCommand, toWireJson } from '../ws/commands.js'

const control = new Hono<AppEnv>()

control.use(authMiddleware)

async function getDeviceForUser(deviceId: string, orgId: string, state: any) {
  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}`
  if (!device || device.org_id !== orgId) throw AppError.notFound()
  return device
}

control.post('/:id/control/claim', async (c) => {
  const { state, user } = c.var
  const deviceId = c.req.param('id')
  await getDeviceForUser(deviceId, user.org_id, state)

  const claimTtl = state.config.control.claim_ttl
  const expiresAt = new Date(Date.now() + claimTtl * 1000)

  // Check existing claim
  const [existing] = await state.db`
    SELECT * FROM control_claims WHERE device_id = ${deviceId}
  `

  if (existing && new Date(existing.expires_at) > new Date() && existing.user_id !== user.sub) {
    // Active claim by another user
    const [claimUser] = await state.db`SELECT display_name FROM users WHERE id = ${existing.user_id}`
    throw AppError.deviceClaimed(existing.user_id, claimUser?.display_name || '', new Date(existing.expires_at))
  }

  let claim
  if (existing && existing.user_id === user.sub) {
    // Same user — refresh
    ;[claim] = await state.db`
      UPDATE control_claims SET expires_at = ${expiresAt} WHERE id = ${existing.id}
      RETURNING *
    `
  } else {
    // New claim (delete any stale)
    await state.db`DELETE FROM control_claims WHERE device_id = ${deviceId}`
    ;[claim] = await state.db`
      INSERT INTO control_claims (device_id, user_id, expires_at)
      VALUES (${deviceId}, ${user.sub}, ${expiresAt})
      RETURNING *
    `
  }

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.sub}, 'claim.acquire', 'device', ${deviceId})
  `.catch(() => {})

  return c.json({ claimed: true, expires_at: claim.expires_at })
})

control.post('/:id/control/release', async (c) => {
  const { state, user } = c.var
  const deviceId = c.req.param('id')
  await getDeviceForUser(deviceId, user.org_id, state)

  if (user.role === 'admin') {
    await state.db`DELETE FROM control_claims WHERE device_id = ${deviceId}`
  } else {
    await state.db`DELETE FROM control_claims WHERE device_id = ${deviceId} AND user_id = ${user.sub}`
  }

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.sub}, 'claim.release', 'device', ${deviceId})
  `.catch(() => {})

  return c.json({ released: true })
})

control.post('/:id/control/command', async (c) => {
  const { state, user } = c.var
  const deviceId = c.req.param('id')
  await getDeviceForUser(deviceId, user.org_id, state)

  // Validate claim (admins bypass)
  if (user.role !== 'admin') {
    const [claim] = await state.db`
      SELECT * FROM control_claims WHERE device_id = ${deviceId}
    `
    if (!claim || claim.user_id !== user.sub || new Date(claim.expires_at) <= new Date()) {
      throw AppError.noControlClaim()
    }
  }

  const body = await c.req.json()
  validateCommand(body)

  // Publish to Redis
  const channel = `commands:${deviceId}`
  const wireJson = JSON.stringify(toWireJson(body))
  await state.redis.publish(channel, wireJson)

  // Refresh claim TTL
  if (user.role !== 'admin') {
    const newExpiry = new Date(Date.now() + state.config.control.claim_ttl * 1000)
    await state.db`
      UPDATE control_claims SET expires_at = ${newExpiry}
      WHERE device_id = ${deviceId} AND user_id = ${user.sub}
    `.catch(() => {})
  }

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${user.sub}, 'command.send', 'device', ${deviceId}, ${JSON.stringify(body)})
  `.catch(() => {})

  return c.json({ status: 'sent' })
})

export default control
