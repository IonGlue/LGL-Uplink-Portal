import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireOperatorOrAbove } from '../auth/middleware.js'
import { IngestClient } from '../ingest/client.js'

const VALID_SOURCE_TYPES = ['encoder', 'srt_listen', 'srt_pull', 'test_pattern', 'placeholder']

const app = new Hono<AppEnv>()

app.use('*', authMiddleware)

function client(c: { var: { state: { config: { supervisor: { api_url: string } } } } }) {
  return new IngestClient(c.var.state.config.supervisor.api_url)
}

app.get('/', async (c) => {
  const sources = await c.var.state.db`
    SELECT id, name, source_type, device_id, config, internal_port, status, process_pid,
           position_x, position_y, created_at
    FROM sources ORDER BY created_at ASC
  `
  return c.json(sources)
})

app.post('/', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string') throw AppError.validation('name is required')
  if (!VALID_SOURCE_TYPES.includes(body.source_type)) {
    throw AppError.validation(`source_type must be one of: ${VALID_SOURCE_TYPES.join(', ')}`)
  }

  const { db } = c.var.state
  const config = body.config ?? {}

  let [source] = await db`
    INSERT INTO sources (name, source_type, device_id, config, position_x, position_y)
    VALUES (
      ${body.name},
      ${body.source_type},
      ${body.device_id ?? null},
      ${JSON.stringify(config)},
      ${body.position_x ?? 100},
      ${body.position_y ?? 100}
    )
    RETURNING *
  `

  // Register with supervisor (skip for placeholder — no process needed)
  if (body.source_type !== 'placeholder') {
    try {
      const supervisorSource = await client(c).createSource({
        id: source.id,
        name: source.name,
        source_type: source.source_type,
        config,
      }) as { internal_port?: number }
      // Write the supervisor-assigned internal_port back to the DB so
      // destinations and the UI can always find it without querying the supervisor.
      if (supervisorSource?.internal_port != null) {
        await c.var.state.db`
          UPDATE sources SET internal_port = ${supervisorSource.internal_port} WHERE id = ${source.id}
        `
        source = { ...source, internal_port: supervisorSource.internal_port }
      }
    } catch (e) {
      console.error('failed to register source with supervisor:', e)
    }
  }

  return c.json(source, 201)
})

app.get('/:id', async (c) => {
  const [source] = await c.var.state.db`SELECT * FROM sources WHERE id = ${c.req.param('id')}`
  if (!source) throw AppError.notFound()
  return c.json(source)
})

app.patch('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  const { db } = c.var.state

  const [existing] = await db`SELECT id FROM sources WHERE id = ${id}`
  if (!existing) throw AppError.notFound()

  if (body.name != null) await db`UPDATE sources SET name = ${body.name} WHERE id = ${id}`
  if (body.device_id !== undefined) await db`UPDATE sources SET device_id = ${body.device_id} WHERE id = ${id}`
  if (body.config != null) await db`UPDATE sources SET config = ${JSON.stringify(body.config)} WHERE id = ${id}`
  if (body.position_x != null) await db`UPDATE sources SET position_x = ${body.position_x} WHERE id = ${id}`
  if (body.position_y != null) await db`UPDATE sources SET position_y = ${body.position_y} WHERE id = ${id}`

  const [updated] = await db`SELECT * FROM sources WHERE id = ${id}`
  return c.json(updated)
})

app.delete('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state

  const [source] = await db`SELECT id, source_type FROM sources WHERE id = ${id}`
  if (!source) throw AppError.notFound()

  if (source.source_type !== 'placeholder') {
    try { await client(c).deleteSource(id) } catch { /* supervisor may not know about it */ }
  }

  await db`DELETE FROM sources WHERE id = ${id}`
  return c.json({ ok: true })
})

app.post('/:id/start', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state
  const [source] = await db`SELECT id, source_type FROM sources WHERE id = ${id}`
  if (!source) throw AppError.notFound()
  if (source.source_type === 'placeholder') throw AppError.validation('cannot start a placeholder source')

  try {
    const result = await client(c).startSource(id)
    await db`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
      VALUES ('user', ${c.var.user.sub}, 'source.start', 'source', ${id})
    `.catch(() => {})
    return c.json(result)
  } catch (e) {
    throw AppError.internal(String(e))
  }
})

app.post('/:id/stop', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state
  const [source] = await db`SELECT id, source_type FROM sources WHERE id = ${id}`
  if (!source) throw AppError.notFound()
  if (source.source_type === 'placeholder') throw AppError.validation('cannot stop a placeholder source')

  try {
    const result = await client(c).stopSource(id)
    await db`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
      VALUES ('user', ${c.var.user.sub}, 'source.stop', 'source', ${id})
    `.catch(() => {})
    return c.json(result)
  } catch (e) {
    throw AppError.internal(String(e))
  }
})

export default app
