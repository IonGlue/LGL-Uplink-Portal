import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireOperatorOrAbove } from '../auth/middleware.js'
import { IngestClient } from '../ingest/client.js'

const app = new Hono<AppEnv>()

app.use('*', authMiddleware)

function client(c: { var: { state: { config: { supervisor: { api_url: string } } } } }) {
  return new IngestClient(c.var.state.config.supervisor.api_url)
}

// List all routes with source + destination names
app.get('/', async (c) => {
  const routes = await c.var.state.db`
    SELECT r.id, r.source_id, r.dest_id, r.enabled, r.created_at,
           s.name AS source_name, s.source_type, s.status AS source_status,
           d.name AS dest_name, d.dest_type, d.status AS dest_status
    FROM routing r
    JOIN sources s ON s.id = r.source_id
    JOIN destinations d ON d.id = r.dest_id
    ORDER BY r.created_at ASC
  `
  return c.json(routes)
})

// Create a route (connect source → destination)
app.post('/', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.source_id !== 'string' || typeof body.dest_id !== 'string') {
    throw AppError.validation('source_id and dest_id are required')
  }

  const { db } = c.var.state

  const [source] = await db`SELECT id FROM sources WHERE id = ${body.source_id}`
  if (!source) throw AppError.validation('source not found')

  const [dest] = await db`SELECT id FROM destinations WHERE id = ${body.dest_id}`
  if (!dest) throw AppError.validation('destination not found')

  let route: Record<string, unknown>
  try {
    const [r] = await db`
      INSERT INTO routing (source_id, dest_id)
      VALUES (${body.source_id}, ${body.dest_id})
      RETURNING *
    `
    route = r as Record<string, unknown>
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('unique') || msg.includes('duplicate')) {
      throw AppError.conflict('route already exists')
    }
    throw e
  }

  // Tell supervisor to wire up the pipeline
  try {
    await client(c).createRoute({ source_id: body.source_id, dest_id: body.dest_id })
  } catch (e) {
    console.error('failed to create route in supervisor:', e)
  }

  await db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, details)
    VALUES ('user', ${c.var.user.sub}, 'route.create', 'routing', ${route.id as string},
            ${JSON.stringify({ source_id: body.source_id, dest_id: body.dest_id })})
  `.catch(() => {})

  return c.json(route, 201)
})

// Delete a route (disconnect)
app.delete('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state

  const [route] = await db`SELECT * FROM routing WHERE id = ${id}`
  if (!route) throw AppError.notFound()

  await db`DELETE FROM routing WHERE id = ${id}`

  try {
    await client(c).deleteRoute(id)
  } catch (e) {
    console.error('failed to delete route in supervisor:', e)
  }

  await db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${c.var.user.sub}, 'route.delete', 'routing', ${id})
  `.catch(() => {})

  return c.json({ ok: true })
})

// Toggle route enabled/disabled
app.patch('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  const { db } = c.var.state

  const [route] = await db`SELECT id FROM routing WHERE id = ${id}`
  if (!route) throw AppError.notFound()

  if (body.enabled != null) {
    await db`UPDATE routing SET enabled = ${!!body.enabled} WHERE id = ${id}`
  }

  const [updated] = await db`SELECT * FROM routing WHERE id = ${id}`
  return c.json(updated)
})

export default app
