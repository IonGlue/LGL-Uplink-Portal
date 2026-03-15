import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { AppError } from '../error.js'
import { authMiddleware } from '../auth/middleware.js'

const organizations = new Hono<AppEnv>()

organizations.use(authMiddleware)

organizations.get('/', async (c) => {
  const { state, user } = c.var

  const [org] = await state.db`
    SELECT
      o.id,
      o.name,
      o.slug,
      COUNT(DISTINCT d.id)::int AS device_count,
      COUNT(DISTINCT u.id)::int AS user_count
    FROM organizations o
    LEFT JOIN devices d ON d.org_id = o.id
    LEFT JOIN users u ON u.org_id = o.id
    WHERE o.id = ${user.org_id}
    GROUP BY o.id
  `
  if (!org) throw AppError.notFound()
  return c.json(org)
})

export default organizations
