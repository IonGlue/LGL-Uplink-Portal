import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware } from '../auth/middleware.js'
import { generateUserToken } from '../auth/jwt.js'
import { verifyPassword } from '../auth/password.js'

const auth = new Hono<AppEnv>()

auth.post('/login', async (c) => {
  const { state } = c.var
  const { email, password } = await c.req.json<{ email: string; password: string }>()

  const [user] = await state.db`
    SELECT id, email, password_hash, display_name, role, org_id, created_at, updated_at
    FROM users WHERE email = ${email}
  `
  if (!user) throw AppError.unauthorized()

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) throw AppError.unauthorized()

  const token = await generateUserToken(
    user.id,
    user.org_id,
    user.role,
    state.config.auth.jwt_secret,
    state.config.auth.user_token_ttl,
  )

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      org_id: user.org_id,
    },
  })
})

auth.post('/refresh', authMiddleware, async (c) => {
  const { state, user } = c.var
  const token = await generateUserToken(
    user.sub,
    user.org_id,
    user.role,
    state.config.auth.jwt_secret,
    state.config.auth.user_token_ttl,
  )
  return c.json({ token })
})

auth.get('/me', authMiddleware, async (c) => {
  const { state, user } = c.var
  const [u] = await state.db`
    SELECT id, email, display_name, role, org_id
    FROM users WHERE id = ${user.sub}
  `
  if (!u) throw AppError.notFound()
  return c.json(u)
})

export default auth
