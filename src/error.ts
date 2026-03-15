import type { Context } from 'hono'

export class AppError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : 'error')
  }

  static notFound() {
    return new AppError(404, { error: 'not found' })
  }

  static unauthorized() {
    return new AppError(401, { error: 'unauthorized' })
  }

  static forbidden() {
    return new AppError(403, { error: 'forbidden' })
  }

  static noControlClaim() {
    return new AppError(403, { error: 'no active control claim' })
  }

  static deviceClaimed(by: string, byName: string, expiresAt: Date) {
    return new AppError(409, {
      error: 'device is claimed by another user',
      claimed_by: by,
      claimed_by_name: byName,
      expires_at: expiresAt.toISOString(),
    })
  }

  static invalidCommand(msg: string) {
    return new AppError(422, { error: `invalid command: ${msg}` })
  }

  static conflict(msg: string) {
    return new AppError(409, { error: msg })
  }

  static validation(msg: string) {
    return new AppError(422, { error: msg })
  }

  static internal(msg: string) {
    console.error('internal error:', msg)
    return new AppError(500, { error: 'internal server error' })
  }
}

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json(err.body, err.status as any)
  }
  console.error('unhandled error:', err)
  return c.json({ error: 'internal server error' }, 500)
}
