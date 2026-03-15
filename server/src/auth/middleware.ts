import { createMiddleware } from 'hono/factory'
import type { AppEnv, UserClaims } from '../types.js'
import { validateUserToken } from './jwt.js'
import { AppError } from '../error.js'

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization')
  if (!header) throw AppError.unauthorized()

  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) throw AppError.unauthorized()

  const claims = await validateUserToken(token, c.var.state.config.auth.jwt_secret)
  c.set('user', claims)
  await next()
})

export function requireAdmin(claims: UserClaims) {
  if (claims.role !== 'admin') throw AppError.forbidden()
}

export function requireOperatorOrAbove(claims: UserClaims) {
  if (claims.role === 'viewer') throw AppError.forbidden()
}
