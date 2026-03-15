import { Hono } from 'hono'
import type { AppEnv, Device } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireAdmin } from '../auth/middleware.js'

function computeConnectionStatus(status: string, lastState: string): string {
  if (status !== 'online') return 'offline'
  if (lastState === 'streaming') return 'streaming'
  if (lastState === 'starting' || lastState === 'connecting') return 'connecting'
  return 'online'
}

const devices = new Hono<AppEnv>()

devices.use(authMiddleware)

// Enrich a device with assignments + control claim info
async function enrichDevice(device: Device, state: any) {
  const assignedUsers = await state.db`
    SELECT user_id FROM device_assignments WHERE device_id = ${device.id}
  `
  const [claim] = await state.db`
    SELECT * FROM control_claims WHERE device_id = ${device.id}
  `
  const controlClaimedBy =
    claim && new Date(claim.expires_at) > new Date() ? claim.user_id : null

  return {
    id: device.id,
    device_id: device.device_id,
    hostname: device.hostname,
    nickname: device.nickname,
    version: device.version,
    status: device.status,
    last_state: device.last_state,
    connection_status: computeConnectionStatus(device.status, device.last_state),
    last_seen_at: device.last_seen_at,
    assigned_users: assignedUsers.map((r: any) => r.user_id),
    control_claimed_by: controlClaimedBy,
    enrollment_state: device.enrollment_state,
    archived: device.archived,
  }
}

devices.get('/', async (c) => {
  const { state, user } = c.var
  const status = c.req.query('status') || null
  const stateFilter = c.req.query('state') || null
  const includeArchived = c.req.query('archived') === 'true'

  let rows: Device[]
  if (user.role === 'admin') {
    rows = await state.db`
      SELECT * FROM devices
      WHERE (${status}::text IS NULL OR status = ${status})
        AND (${stateFilter}::text IS NULL OR last_state = ${stateFilter})
        AND (${includeArchived} OR archived = false)
      ORDER BY registered_at
    ` as Device[]
  } else {
    rows = await state.db`
      SELECT * FROM devices
      WHERE org_id = ${user.org_id}
        AND (${status}::text IS NULL OR status = ${status})
        AND (${stateFilter}::text IS NULL OR last_state = ${stateFilter})
        AND (${includeArchived} OR archived = false)
      ORDER BY registered_at
    ` as Device[]
  }

  const enriched = await Promise.all(rows.map((d) => enrichDevice(d, state)))
  return c.json({ devices: enriched })
})

devices.get('/unassigned', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const rows = await state.db`SELECT * FROM devices WHERE org_id IS NULL ORDER BY registered_at`
  return c.json({ devices: rows })
})

devices.get('/pending', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const rows = await state.db`
    SELECT id, device_id, hardware_id, hostname, version, enrollment_code, status, registered_at
    FROM devices WHERE enrollment_state = 'pending' ORDER BY registered_at
  `
  return c.json({ devices: rows })
})

devices.get('/:id', async (c) => {
  const { state, user } = c.var
  const deviceId = c.req.param('id')
  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}` as Device[]
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  return c.json(await enrichDevice(device, state))
})

devices.post('/:id/enroll', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')
  const { code } = await c.req.json<{ code: string }>()

  const result = await state.db`
    UPDATE devices SET
      enrollment_state = 'enrolled',
      enrolled_at = now(),
      enrolled_by = ${user.sub},
      updated_at = now()
    WHERE id = ${deviceId}
      AND enrollment_state = 'pending'
      AND enrollment_code = ${code}
  `
  if (result.count === 0) {
    throw AppError.invalidCommand('code does not match or device is not pending enrollment')
  }

  // Notify device via Redis pub/sub
  await state.redis.publish(`enrollment:${deviceId}`, 'approved').catch(() => {})

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.sub}, 'device.enroll', 'device', ${deviceId})
  `.catch(() => {})

  return c.json({ enrolled: true })
})

devices.post('/:id/reject', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')

  const result = await state.db`
    UPDATE devices SET enrollment_state = 'rejected', updated_at = now()
    WHERE id = ${deviceId} AND enrollment_state = 'pending'
  `
  if (result.count === 0) throw AppError.notFound()

  await state.redis.publish(`enrollment:${deviceId}`, 'rejected').catch(() => {})

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.sub}, 'device.reject', 'device', ${deviceId})
  `.catch(() => {})

  return c.json({ rejected: true })
})

devices.post('/:id/claim-to-org', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')

  const result = await state.db`
    UPDATE devices SET org_id = ${user.org_id}, updated_at = now()
    WHERE id = ${deviceId} AND org_id IS NULL
  `
  if (result.count === 0) throw AppError.conflict('device is already assigned to an org')

  return c.json({ assigned: true })
})

devices.post('/:id/decommission', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')
  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}` as Device[]
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  await state.db`
    UPDATE devices SET org_id = NULL, status = 'offline', updated_at = now()
    WHERE id = ${deviceId}
  `
  return c.json({ decommissioned: true })
})

devices.patch('/:id/nickname', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')
  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}` as Device[]
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  const { nickname } = await c.req.json<{ nickname?: string | null }>()
  if (nickname && nickname.length > 100) {
    throw AppError.invalidCommand('nickname must be <= 100 characters')
  }

  await state.db`UPDATE devices SET nickname = ${nickname ?? null}, updated_at = now() WHERE id = ${deviceId}`

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${user.sub}, 'device.set_nickname', 'device', ${deviceId}, ${nickname ? JSON.stringify({ nickname }) : null})
  `.catch(() => {})

  return c.json({ ok: true })
})

devices.delete('/:id', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')
  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}` as Device[]
  if (!device) throw AppError.notFound()
  if (!device.archived) throw AppError.validation('device must be archived before it can be deleted')

  state.wsRegistry.remove(deviceId)
  await state.db`DELETE FROM devices WHERE id = ${deviceId}`

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${user.sub}, 'device.delete', 'device', ${deviceId}, ${JSON.stringify({ device_id: device.device_id, hostname: device.hostname })})
  `.catch(() => {})

  return c.json({ deleted: true })
})

devices.post('/:id/archive', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')
  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}` as Device[]
  if (!device) throw AppError.notFound()

  await state.db`UPDATE devices SET archived = true, updated_at = now() WHERE id = ${deviceId}`

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.sub}, 'device.archive', 'device', ${deviceId})
  `.catch(() => {})

  return c.json({ archived: true })
})

devices.post('/:id/unarchive', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')
  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}` as Device[]
  if (!device) throw AppError.notFound()

  await state.db`UPDATE devices SET archived = false, updated_at = now() WHERE id = ${deviceId}`

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.sub}, 'device.unarchive', 'device', ${deviceId})
  `.catch(() => {})

  return c.json({ archived: false })
})

export default devices
