import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware, requireAdmin } from '../auth/middleware.js'
import { hashPassword } from '../auth/password.js'

const app = new Hono<AppEnv>()

app.use('*', authMiddleware)

app.get('/', async (c) => {
  requireAdmin(c.var.user)
  const users = await c.var.state.db`
    SELECT id, email, display_name, role, created_at, updated_at FROM users ORDER BY created_at ASC
  `
  return c.json(users)
})

app.post('/', async (c) => {
  requireAdmin(c.var.user)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    throw AppError.validation('email and password are required')
  }
  const role = body.role ?? 'viewer'
  if (!['admin', 'operator', 'viewer'].includes(role)) {
    throw AppError.validation('role must be admin, operator, or viewer')
  }
  if (body.password.length < 8) throw AppError.validation('password must be at least 8 characters')

  const hash = await hashPassword(body.password)
  const { db } = c.var.state
  const existing = await db`SELECT id FROM users WHERE email = ${body.email.toLowerCase()}`
  if (existing.length > 0) throw AppError.conflict('email already in use')

  const [user] = await db`
    INSERT INTO users (email, password_hash, display_name, role)
    VALUES (${body.email.toLowerCase()}, ${hash}, ${body.display_name ?? body.email}, ${role})
    RETURNING id, email, display_name, role, created_at
  `
  return c.json(user, 201)
})

app.get('/:id', async (c) => {
  requireAdmin(c.var.user)
  const [user] = await c.var.state.db`
    SELECT id, email, display_name, role, created_at, updated_at FROM users WHERE id = ${c.req.param('id')}
  `
  if (!user) throw AppError.notFound()
  return c.json(user)
})

app.patch('/:id', async (c) => {
  requireAdmin(c.var.user)
  const body = await c.req.json().catch(() => ({}))
  const { db } = c.var.state
  const id = c.req.param('id')

  const [existing] = await db`SELECT id FROM users WHERE id = ${id}`
  if (!existing) throw AppError.notFound()

  if (body.password != null) {
    if (body.password.length < 8) throw AppError.validation('password must be at least 8 characters')
    const hash = await hashPassword(body.password)
    await db`UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${id}`
  }
  if (body.role != null) {
    if (!['admin', 'operator', 'viewer'].includes(body.role)) throw AppError.validation('invalid role')
    await db`UPDATE users SET role = ${body.role}, updated_at = now() WHERE id = ${id}`
  }
  if (body.display_name != null) {
    await db`UPDATE users SET display_name = ${body.display_name}, updated_at = now() WHERE id = ${id}`
  }

  const [updated] = await db`SELECT id, email, display_name, role, updated_at FROM users WHERE id = ${id}`
  return c.json(updated)
})

app.delete('/:id', async (c) => {
  requireAdmin(c.var.user)
  const id = c.req.param('id')
  if (id === c.var.user.sub) throw AppError.validation('cannot delete your own account')
  const result = await c.var.state.db`DELETE FROM users WHERE id = ${id} RETURNING id`
  if (result.length === 0) throw AppError.notFound()
  return c.json({ ok: true })
})

export default app
