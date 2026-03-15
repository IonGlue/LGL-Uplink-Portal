import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { verifyPassword } from '../auth/password.js'
import { generateUserToken } from '../auth/jwt.js'
import { authMiddleware } from '../auth/middleware.js'

const app = new Hono<AppEnv>()

app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    throw AppError.validation('email and password are required')
  }

  const { db, config } = c.var.state
  const [user] = await db`SELECT * FROM users WHERE email = ${body.email.toLowerCase()} LIMIT 1`
  if (!user) throw AppError.unauthorized()

  const ok = await verifyPassword(body.password, user.password_hash)
  if (!ok) throw AppError.unauthorized()

  const token = await generateUserToken(user.id, user.role, config.auth.jwt_secret, config.auth.user_token_ttl)

  await db`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id)
    VALUES ('user', ${user.id}, 'auth.login', 'user', ${user.id})
  `.catch(() => {})

  return c.json({
    token,
    user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
  })
})

app.post('/refresh', authMiddleware, async (c) => {
  const claims = c.var.user
  const { db, config } = c.var.state

  const [user] = await db`SELECT id, role FROM users WHERE id = ${claims.sub} LIMIT 1`
  if (!user) throw AppError.unauthorized()

  const token = await generateUserToken(user.id, user.role, config.auth.jwt_secret, config.auth.user_token_ttl)
  return c.json({ token })
})

app.get('/me', authMiddleware, async (c) => {
  const { db } = c.var.state
  const [user] = await db`SELECT id, email, display_name, role, created_at FROM users WHERE id = ${c.var.user.sub}`
  if (!user) throw AppError.unauthorized()
  return c.json(user)
})

export default app
