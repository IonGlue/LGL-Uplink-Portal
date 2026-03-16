import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { verifyPassword } from '../auth/password.js'
import { generateUserToken } from '../auth/jwt.js'
import { authMiddleware } from '../auth/middleware.js'
import { isLogtoMode } from '../auth/logto.js'

const TENANT_SLUG = process.env.TENANT_SLUG ?? ''

const app = new Hono<AppEnv>()

// GET /api/auth/config — tells the SPA whether local login is active or to
// redirect to the tenant portal (Logto mode).
app.get('/config', (c) => {
  if (isLogtoMode()) {
    return c.json({
      local_login: false,
      portal_url: `https://${TENANT_SLUG}.home.lgl-os.com`,
    })
  }
  return c.json({ local_login: true })
})

app.post('/login', async (c) => {
  // In Logto mode login is handled by the tenant portal.
  if (isLogtoMode()) {
    return c.json(
      { error: 'Login is handled via the tenant portal', portal_url: `https://${TENANT_SLUG}.home.lgl-os.com` },
      401,
    )
  }

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
  // In Logto mode token refresh is handled by the tenant portal.
  if (isLogtoMode()) {
    return c.json({ error: 'Token refresh is handled by the tenant portal' }, 400)
  }

  const claims = c.var.user
  const { db, config } = c.var.state

  const [user] = await db`SELECT id, role FROM users WHERE id = ${claims.sub} LIMIT 1`
  if (!user) throw AppError.unauthorized()

  const token = await generateUserToken(user.id, user.role, config.auth.jwt_secret, config.auth.user_token_ttl)
  return c.json({ token })
})

app.get('/me', authMiddleware, async (c) => {
  const { db } = c.var.state
  const claims = c.var.user

  // In Logto mode, auto-provision the user into the local DB on first access
  // so FK constraints are satisfied for any subsequent queries by other routes.
  if (claims._logto) {
    const { id, email, display_name, role } = claims._logto
    await db`
      INSERT INTO users (id, email, password_hash, display_name, role)
      VALUES (${id}, ${email}, '$external$', ${display_name}, ${role})
      ON CONFLICT (id) DO UPDATE
        SET email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            role = EXCLUDED.role,
            updated_at = now()
    `.catch(() => {})
  }

  const lookupId = claims._logto?.id ?? claims.sub
  const [user] = await db`SELECT id, email, display_name, role, created_at FROM users WHERE id = ${lookupId}`
  if (!user) throw AppError.unauthorized()
  return c.json(user)
})

export default app
