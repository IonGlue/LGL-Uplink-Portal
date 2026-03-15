import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireOperatorOrAbove } from '../auth/middleware.js'
import { IngestClient } from '../ingest/client.js'

const VALID_DEST_TYPES = ['rtmp', 'srt_push', 'hls', 'recorder', 'lgl_ingest', 'placeholder']

const app = new Hono<AppEnv>()

app.use('*', authMiddleware)

function client(c: { var: { state: { config: { supervisor: { api_url: string } } } } }) {
  return new IngestClient(c.var.state.config.supervisor.api_url)
}

app.get('/', async (c) => {
  const dests = await c.var.state.db`
    SELECT id, name, dest_type, config, status, process_pid, position_x, position_y, created_at
    FROM destinations ORDER BY created_at ASC
  `
  return c.json(dests)
})

app.post('/', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string') throw AppError.validation('name is required')
  if (!VALID_DEST_TYPES.includes(body.dest_type)) {
    throw AppError.validation(`dest_type must be one of: ${VALID_DEST_TYPES.join(', ')}`)
  }

  const { db } = c.var.state
  const config = body.config ?? {}

  const [dest] = await db`
    INSERT INTO destinations (name, dest_type, config, position_x, position_y)
    VALUES (
      ${body.name},
      ${body.dest_type},
      ${JSON.stringify(config)},
      ${body.position_x ?? 900},
      ${body.position_y ?? 100}
    )
    RETURNING *
  `

  if (body.dest_type !== 'placeholder') {
    try {
      await client(c).createDest({ id: dest.id, name: dest.name, dest_type: dest.dest_type, config })
    } catch (e) {
      console.error('failed to register destination with supervisor:', e)
    }
  }

  return c.json(dest, 201)
})

app.get('/:id', async (c) => {
  const [dest] = await c.var.state.db`SELECT * FROM destinations WHERE id = ${c.req.param('id')}`
  if (!dest) throw AppError.notFound()
  return c.json(dest)
})

app.patch('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  const { db } = c.var.state

  const [existing] = await db`SELECT id FROM destinations WHERE id = ${id}`
  if (!existing) throw AppError.notFound()

  if (body.name != null) await db`UPDATE destinations SET name = ${body.name} WHERE id = ${id}`
  if (body.config != null) await db`UPDATE destinations SET config = ${JSON.stringify(body.config)} WHERE id = ${id}`
  if (body.position_x != null) await db`UPDATE destinations SET position_x = ${body.position_x} WHERE id = ${id}`
  if (body.position_y != null) await db`UPDATE destinations SET position_y = ${body.position_y} WHERE id = ${id}`

  const [updated] = await db`SELECT * FROM destinations WHERE id = ${id}`
  return c.json(updated)
})

app.delete('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state

  const [dest] = await db`SELECT id, dest_type FROM destinations WHERE id = ${id}`
  if (!dest) throw AppError.notFound()

  if (dest.dest_type !== 'placeholder') {
    try { await client(c).deleteDest(id) } catch { /* supervisor may not know about it */ }
  }

  await db`DELETE FROM destinations WHERE id = ${id}`
  return c.json({ ok: true })
})

app.post('/:id/start', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const [dest] = await c.var.state.db`SELECT id, dest_type FROM destinations WHERE id = ${id}`
  if (!dest) throw AppError.notFound()
  if (dest.dest_type === 'placeholder') throw AppError.validation('cannot start a placeholder destination')

  try {
    const result = await client(c).startDest(id)
    return c.json(result)
  } catch (e) {
    throw AppError.internal(String(e))
  }
})

app.post('/:id/stop', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const [dest] = await c.var.state.db`SELECT id, dest_type FROM destinations WHERE id = ${id}`
  if (!dest) throw AppError.notFound()
  if (dest.dest_type === 'placeholder') throw AppError.validation('cannot stop a placeholder destination')

  try {
    const result = await client(c).stopDest(id)
    return c.json(result)
  } catch (e) {
    throw AppError.internal(String(e))
  }
})

export default app
