import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireAdmin } from '../auth/middleware.js'

const assignments = new Hono<AppEnv>()

assignments.use(authMiddleware)

assignments.get('/:id/assignments', async (c) => {
  const { state, user } = c.var
  const deviceId = c.req.param('id')

  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}`
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  const rows = await state.db`
    SELECT id, device_id, user_id, assigned_at, assigned_by
    FROM device_assignments WHERE device_id = ${deviceId}
  `
  return c.json(rows)
})

assignments.post('/:id/assignments', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')

  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}`
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  const { user_id } = await c.req.json<{ user_id: string }>()

  const [assignment] = await state.db`
    INSERT INTO device_assignments (device_id, user_id, assigned_by)
    VALUES (${deviceId}, ${user_id}, ${user.sub})
    ON CONFLICT (device_id, user_id) DO UPDATE SET assigned_by = ${user.sub}
    RETURNING id, device_id, user_id, assigned_at, assigned_by
  `
  return c.json(assignment)
})

assignments.delete('/:id/assignments/:userId', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)
  const deviceId = c.req.param('id')
  const userId = c.req.param('userId')

  const [device] = await state.db`SELECT * FROM devices WHERE id = ${deviceId}`
  if (!device || device.org_id !== user.org_id) throw AppError.notFound()

  const result = await state.db`
    DELETE FROM device_assignments WHERE device_id = ${deviceId} AND user_id = ${userId}
  `
  if (result.count === 0) throw AppError.notFound()

  return c.json({ deleted: true })
})

export default assignments
