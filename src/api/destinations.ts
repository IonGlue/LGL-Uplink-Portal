import { Hono } from 'hono'
import type { AppEnv, Destination } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireAdmin } from '../auth/middleware.js'

const destinations = new Hono<AppEnv>()

destinations.use(authMiddleware)

// List destinations (with optional search)
destinations.get('/', async (c) => {
  const { state, user } = c.var
  const search = c.req.query('search') || null

  const rows = search
    ? await state.db`
        SELECT * FROM destinations
        WHERE org_id = ${user.org_id}
          AND (name ILIKE ${'%' + search + '%'} OR description ILIKE ${'%' + search + '%'} OR srt_host ILIKE ${'%' + search + '%'})
        ORDER BY name
      ` as Destination[]
    : await state.db`
        SELECT * FROM destinations
        WHERE org_id = ${user.org_id}
        ORDER BY name
      ` as Destination[]

  // Strip passphrase values from list response
  const safe = rows.map((d) => ({
    ...d,
    srt_passphrase_set: !!d.srt_passphrase,
    srt_passphrase: undefined,
  }))

  return c.json({ destinations: safe })
})

// Get single destination
destinations.get('/:id', async (c) => {
  const { state, user } = c.var
  const id = c.req.param('id')
  const [dest] = await state.db`SELECT * FROM destinations WHERE id = ${id}` as Destination[]
  if (!dest || dest.org_id !== user.org_id) throw AppError.notFound()

  return c.json({
    ...dest,
    srt_passphrase_set: !!dest.srt_passphrase,
    srt_passphrase: undefined,
  })
})

// Create destination
destinations.post('/', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)

  const body = await c.req.json<{
    name: string
    srt_host: string
    srt_port: number
    srt_latency_ms?: number
    srt_passphrase?: string
    description?: string
  }>()

  if (!body.name?.trim()) throw AppError.validation('name is required')
  if (!body.srt_host?.trim()) throw AppError.validation('srt_host is required')
  if (!body.srt_port || body.srt_port < 1 || body.srt_port > 65535) throw AppError.validation('srt_port must be 1-65535')

  const [dest] = await state.db`
    INSERT INTO destinations (org_id, name, srt_host, srt_port, srt_latency_ms, srt_passphrase, description, created_by)
    VALUES (
      ${user.org_id},
      ${body.name.trim()},
      ${body.srt_host.trim()},
      ${body.srt_port},
      ${body.srt_latency_ms ?? 200},
      ${body.srt_passphrase?.trim() || null},
      ${body.description?.trim() ?? ''},
      ${user.sub}
    )
    RETURNING *
  ` as Destination[]

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${user.sub}, 'destination.create', 'destination', ${dest.id}, ${JSON.stringify({ name: dest.name })})
  `.catch(() => {})

  return c.json({
    ...dest,
    srt_passphrase_set: !!dest.srt_passphrase,
    srt_passphrase: undefined,
  }, 201)
})

// Update destination
destinations.patch('/:id', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const id = c.req.param('id')

  const [existing] = await state.db`SELECT * FROM destinations WHERE id = ${id}` as Destination[]
  if (!existing || existing.org_id !== user.org_id) throw AppError.notFound()

  const body = await c.req.json<{
    name?: string
    srt_host?: string
    srt_port?: number
    srt_latency_ms?: number
    srt_passphrase?: string | null
    description?: string
  }>()

  if (body.srt_port !== undefined && (body.srt_port < 1 || body.srt_port > 65535)) {
    throw AppError.validation('srt_port must be 1-65535')
  }

  const name = body.name?.trim() ?? existing.name
  const srt_host = body.srt_host?.trim() ?? existing.srt_host
  const srt_port = body.srt_port ?? existing.srt_port
  const srt_latency_ms = body.srt_latency_ms ?? existing.srt_latency_ms
  const description = body.description?.trim() ?? existing.description
  // null = clear passphrase, undefined = keep, string = set new
  const srt_passphrase = body.srt_passphrase === null
    ? null
    : body.srt_passphrase?.trim() || existing.srt_passphrase

  const [updated] = await state.db`
    UPDATE destinations SET
      name = ${name},
      srt_host = ${srt_host},
      srt_port = ${srt_port},
      srt_latency_ms = ${srt_latency_ms},
      srt_passphrase = ${srt_passphrase},
      description = ${description},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  ` as Destination[]

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${user.sub}, 'destination.update', 'destination', ${id}, ${JSON.stringify({ name })})
  `.catch(() => {})

  return c.json({
    ...updated,
    srt_passphrase_set: !!updated.srt_passphrase,
    srt_passphrase: undefined,
  })
})

// Delete destination
destinations.delete('/:id', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const id = c.req.param('id')

  const [existing] = await state.db`SELECT * FROM destinations WHERE id = ${id}` as Destination[]
  if (!existing || existing.org_id !== user.org_id) throw AppError.notFound()

  await state.db`DELETE FROM destinations WHERE id = ${id}`

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${user.sub}, 'destination.delete', 'destination', ${id}, ${JSON.stringify({ name: existing.name })})
  `.catch(() => {})

  return c.json({ deleted: true })
})

// Deploy destination to a device
destinations.post('/:id/deploy/:deviceId', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const destId = c.req.param('id')
  const deviceId = c.req.param('deviceId')

  const [dest] = await state.db`SELECT * FROM destinations WHERE id = ${destId}` as Destination[]
  if (!dest || dest.org_id !== user.org_id) throw AppError.notFound()

  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}`
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()
  if (device.status !== 'online') throw AppError.validation('device must be online to deploy a destination')

  // Claim control
  const claimTtl = state.config.control.claim_ttl
  const expiresAt = new Date(Date.now() + claimTtl * 1000)
  await state.db`DELETE FROM control_claims WHERE device_id = ${deviceId}`.catch(() => {})
  await state.db`
    INSERT INTO control_claims (device_id, user_id, expires_at)
    VALUES (${deviceId}, ${user.sub}, ${expiresAt})
  `.catch(() => {})

  // Build config command
  const cmd: Record<string, unknown> = {
    msg_type: 'command',
    cmd: 'set_config',
    srt_host: dest.srt_host,
    srt_port: dest.srt_port,
    srt_latency_ms: dest.srt_latency_ms,
  }
  if (dest.srt_passphrase) {
    cmd.srt_passphrase = dest.srt_passphrase
  }

  // Publish command via Redis (channel uses the internal UUID)
  await state.redis.publish(`commands:${deviceId}`, JSON.stringify(cmd))

  await state.db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${user.sub}, 'destination.deploy', 'device', ${deviceId},
      ${JSON.stringify({ destination_id: destId, destination_name: dest.name })})
  `.catch(() => {})

  return c.json({ deployed: true, destination: dest.name, device_id: device.device_id })
})

export default destinations
