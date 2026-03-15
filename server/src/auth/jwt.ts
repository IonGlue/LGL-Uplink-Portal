import { SignJWT, jwtVerify } from 'jose'
import type { UserClaims, DeviceClaims } from '../types.js'
import { AppError } from '../error.js'

function getSecret(secret: string) {
  return new TextEncoder().encode(secret)
}

export async function generateDeviceToken(
  deviceUuid: string,
  deviceId: string,
  secret: string,
  ttlSecs: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: deviceUuid, device_id: deviceId, type: 'device', iat: now })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(now + ttlSecs)
    .sign(getSecret(secret))
}

export async function generateUserToken(
  userId: string,
  role: string,
  secret: string,
  ttlSecs: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: userId, role, type: 'user', iat: now })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(now + ttlSecs)
    .sign(getSecret(secret))
}

export async function validateUserToken(token: string, secret: string): Promise<UserClaims> {
  try {
    const { payload } = await jwtVerify(token, getSecret(secret))
    if (payload.type !== 'user') throw new Error('not a user token')
    return payload as unknown as UserClaims
  } catch {
    throw AppError.unauthorized()
  }
}

export async function validateDeviceToken(token: string, secret: string): Promise<DeviceClaims> {
  try {
    const { payload } = await jwtVerify(token, getSecret(secret))
    if (payload.type !== 'device') throw new Error('not a device token')
    return payload as unknown as DeviceClaims
  } catch {
    throw AppError.unauthorized()
  }
}
