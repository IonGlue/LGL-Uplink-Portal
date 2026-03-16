// Sync group API — multi-camera feed alignment
//
// A sync group collects N encoder sources and aligns them to a common
// wall-clock timeline.  The target_delay_ms parameter is configurable so
// the system works from local LANs (200 ms) to intercontinental links
// (1000–1500 ms).

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

// ── List ──────────────────────────────────────────────────────────────────────

app.get('/', async (c) => {
  const groups = await c.var.state.db`
    SELECT
      sg.id,
      sg.name,
      sg.target_delay_ms,
      sg.max_offset_ms,
      sg.status,
      sg.created_at,
      sg.updated_at,
      COALESCE(
        json_agg(sgm.source_id) FILTER (WHERE sgm.source_id IS NOT NULL),
        '[]'
      ) AS source_ids
    FROM sync_groups sg
    LEFT JOIN sync_group_members sgm ON sgm.sync_group_id = sg.id
    GROUP BY sg.id
    ORDER BY sg.created_at ASC
  `
  return c.json(groups)
})

// ── Get one ───────────────────────────────────────────────────────────────────

app.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [group] = await c.var.state.db`
    SELECT
      sg.id, sg.name, sg.target_delay_ms, sg.max_offset_ms, sg.status,
      sg.created_at, sg.updated_at,
      COALESCE(
        json_agg(sgm.source_id) FILTER (WHERE sgm.source_id IS NOT NULL),
        '[]'
      ) AS source_ids
    FROM sync_groups sg
    LEFT JOIN sync_group_members sgm ON sgm.sync_group_id = sg.id
    WHERE sg.id = ${id}
    GROUP BY sg.id
  `
  if (!group) throw AppError.notFound()
  return c.json(group)
})

// ── Create ────────────────────────────────────────────────────────────────────

app.post('/', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string') throw AppError.validation('name is required')

  const target_delay_ms = Number(body.target_delay_ms ?? 500)
  const max_offset_ms = Number(body.max_offset_ms ?? 2000)
  const source_ids: string[] = Array.isArray(body.source_ids) ? body.source_ids : []

  const { db } = c.var.state

  // Validate sources exist
  for (const sid of source_ids) {
    const [src] = await db`SELECT id FROM sources WHERE id = ${sid}`
    if (!src) throw AppError.validation(`source not found: ${sid}`)
  }

  // Persist group
  const [group] = await db`
    INSERT INTO sync_groups (name, target_delay_ms, max_offset_ms)
    VALUES (${body.name}, ${target_delay_ms}, ${max_offset_ms})
    RETURNING *
  `

  // Persist members
  for (const sid of source_ids) {
    await db`
      INSERT INTO sync_group_members (sync_group_id, source_id)
      VALUES (${group.id}, ${sid})
      ON CONFLICT DO NOTHING
    `
  }

  // Register with supervisor
  try {
    await client(c).createSyncGroup({
      id: group.id,
      name: group.name,
      target_delay_ms,
      max_offset_ms,
      source_ids,
    })
  } catch (e) {
    console.error('failed to register sync group with supervisor:', e)
  }

  return c.json({ ...group, source_ids }, 201)
})

// ── Update ────────────────────────────────────────────────────────────────────

app.put('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const { db } = c.var.state

  const [existing] = await db`SELECT id FROM sync_groups WHERE id = ${id}`
  if (!existing) throw AppError.notFound()

  if (body.name != null) {
    await db`UPDATE sync_groups SET name = ${body.name} WHERE id = ${id}`
  }
  if (body.target_delay_ms != null) {
    await db`UPDATE sync_groups SET target_delay_ms = ${Number(body.target_delay_ms)} WHERE id = ${id}`
  }
  if (body.max_offset_ms != null) {
    await db`UPDATE sync_groups SET max_offset_ms = ${Number(body.max_offset_ms)} WHERE id = ${id}`
  }
  if (Array.isArray(body.source_ids)) {
    // Replace membership
    await db`DELETE FROM sync_group_members WHERE sync_group_id = ${id}`
    for (const sid of body.source_ids as string[]) {
      await db`
        INSERT INTO sync_group_members (sync_group_id, source_id)
        VALUES (${id}, ${sid})
        ON CONFLICT DO NOTHING
      `
    }
  }

  // Propagate to supervisor
  try {
    await client(c).updateSyncGroup(id, body)
  } catch (e) {
    console.error('failed to update sync group in supervisor:', e)
  }

  const [updated] = await db`
    SELECT sg.*, COALESCE(json_agg(sgm.source_id) FILTER (WHERE sgm.source_id IS NOT NULL), '[]') AS source_ids
    FROM sync_groups sg
    LEFT JOIN sync_group_members sgm ON sgm.sync_group_id = sg.id
    WHERE sg.id = ${id}
    GROUP BY sg.id
  `
  return c.json(updated)
})

// ── Delete ────────────────────────────────────────────────────────────────────

app.delete('/:id', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state

  const [existing] = await db`SELECT id FROM sync_groups WHERE id = ${id}`
  if (!existing) throw AppError.notFound()

  try { await client(c).deleteSyncGroup(id) } catch { /* supervisor may not know about it */ }

  await db`DELETE FROM sync_groups WHERE id = ${id}`
  return c.json({ ok: true })
})

// ── Start / Stop ──────────────────────────────────────────────────────────────

app.post('/:id/start', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state
  const [group] = await db`SELECT id FROM sync_groups WHERE id = ${id}`
  if (!group) throw AppError.notFound()

  try {
    const result = await client(c).startSyncGroup(id)
    await db`UPDATE sync_groups SET status = 'active' WHERE id = ${id}`

    // Persist the supervisor-assigned aligned ports so they survive a restart.
    if (result.aligned_ports && typeof result.aligned_ports === 'object') {
      // Clear stale entries first, then insert fresh assignments.
      await db`DELETE FROM sync_group_ports WHERE sync_group_id = ${id}`
      for (const [sourceId, port] of Object.entries(result.aligned_ports)) {
        await db`
          INSERT INTO sync_group_ports (sync_group_id, source_id, aligned_port)
          VALUES (${id}, ${sourceId}, ${port as number})
          ON CONFLICT (sync_group_id, source_id) DO UPDATE SET aligned_port = EXCLUDED.aligned_port
        `
      }
    }

    return c.json(result)
  } catch (e) {
    await db`UPDATE sync_groups SET status = 'error' WHERE id = ${id}`
    throw AppError.internal(String(e))
  }
})

app.post('/:id/stop', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const { db } = c.var.state
  const [group] = await db`SELECT id FROM sync_groups WHERE id = ${id}`
  if (!group) throw AppError.notFound()

  try {
    const result = await client(c).stopSyncGroup(id)
    await db`UPDATE sync_groups SET status = 'idle' WHERE id = ${id}`
    await db`DELETE FROM sync_group_ports WHERE sync_group_id = ${id}`
    return c.json(result)
  } catch (e) {
    throw AppError.internal(String(e))
  }
})

// ── Live status (stream offsets) ──────────────────────────────────────────────

app.get('/:id/status', async (c) => {
  requireOperatorOrAbove(c.var.user)
  const id = c.req.param('id')
  const [group] = await c.var.state.db`SELECT id FROM sync_groups WHERE id = ${id}`
  if (!group) throw AppError.notFound()

  try {
    const status = await client(c).syncGroupStatus(id)
    return c.json(status)
  } catch (e) {
    throw AppError.internal(String(e))
  }
})

export default app
