import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireAdmin } from '../auth/middleware.js'
import { hashPassword } from '../auth/password.js'

const users = new Hono<AppEnv>()

users.use(authMiddleware)

users.get('/', async (c) => {
  const { state, user } = c.var
  const rows = await state.db`
    SELECT id, email, display_name, role, org_id
    FROM users WHERE org_id = ${user.org_id} ORDER BY created_at
  `
  return c.json(rows)
})

users.post('/', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)

  const { email, display_name, role, password } = await c.req.json<{
    email: string
    display_name: string
    role: string
    password: string
  }>()

  if (!['admin', 'operator', 'viewer'].includes(role)) {
    throw AppError.validation('invalid role')
  }

  const password_hash = await hashPassword(password)
  const [created] = await state.db`
    INSERT INTO users (email, password_hash, display_name, role, org_id)
    VALUES (${email}, ${password_hash}, ${display_name}, ${role}, ${user.org_id})
    RETURNING id, email, display_name, role, org_id
  `
  return c.json(created)
})

users.patch('/:id', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)

  const userId = c.req.param('id')
  const [existing] = await state.db`SELECT * FROM users WHERE id = ${userId}`
  if (!existing || existing.org_id !== user.org_id) throw AppError.notFound()

  const { display_name, role } = await c.req.json<{ display_name?: string; role?: string }>()

  if (role && !['admin', 'operator', 'viewer'].includes(role)) {
    throw AppError.validation('invalid role')
  }

  const [updated] = await state.db`
    UPDATE users SET
      display_name = COALESCE(${display_name ?? null}, display_name),
      role = COALESCE(${role ?? null}, role),
      updated_at = now()
    WHERE id = ${userId}
    RETURNING id, email, display_name, role, org_id
  `
  if (!updated) throw AppError.notFound()
  return c.json(updated)
})

users.delete('/:id', async (c) => {
  const { state, user } = c.var
  requireAdmin(user)

  const userId = c.req.param('id')
  const [existing] = await state.db`SELECT * FROM users WHERE id = ${userId}`
  if (!existing || existing.org_id !== user.org_id) throw AppError.notFound()

  if (userId === user.sub) {
    throw AppError.validation('cannot delete yourself')
  }

  await state.db`DELETE FROM users WHERE id = ${userId}`
  return c.json({ deleted: true })
})

export default users
