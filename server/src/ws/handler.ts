import { WebSocket } from 'ws'
import { Redis } from 'ioredis'
import type { AppState, Device, TelemetryReport } from '../types.js'
import { generateDeviceToken } from '../auth/jwt.js'

function send(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function waitForMessage(ws: WebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')) }, timeoutMs)
    const onMessage = (data: Buffer | string) => { cleanup(); resolve(data.toString()) }
    const onClose = () => { cleanup(); reject(new Error('closed')) }
    const onError = (err: Error) => { cleanup(); reject(err) }
    function cleanup() {
      clearTimeout(timer)
      ws.removeListener('message', onMessage)
      ws.removeListener('close', onClose)
      ws.removeListener('error', onError)
    }
    ws.once('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

export async function handleDeviceConnection(ws: WebSocket, state: AppState) {
  const { db } = state

  let firstMsg: string
  try {
    firstMsg = await waitForMessage(ws, 10_000)
  } catch {
    console.warn('device did not send registration in time')
    ws.close()
    return
  }

  let register: {
    msg_type: string
    device_id: string
    hardware_id: string
    hostname: string
    version: string
    verification_code?: string
  }
  try {
    register = JSON.parse(firstMsg)
    if (register.msg_type !== 'register') throw new Error('unexpected')
  } catch {
    console.warn('device sent unexpected first message')
    ws.close()
    return
  }

  console.log(`device registering: ${register.device_id}`)

  let device: Device
  let isNew: boolean
  try {
    const existing = await db`SELECT * FROM devices WHERE device_id = ${register.device_id}`
    const verificationCode = register.verification_code ?? null
    if (existing.length === 0) {
      const code = register.device_id.slice(0, 12)
      const [d] = await db`
        INSERT INTO devices (device_id, hardware_id, hostname, version, status, last_seen_at, enrollment_state, enrollment_code, verification_code, verification_state)
        VALUES (${register.device_id}, ${register.hardware_id}, ${register.hostname}, ${register.version}, 'online', now(), 'pending', ${code}, ${verificationCode}, 'unverified')
        RETURNING *
      `
      device = d as Device
      isNew = true
    } else {
      const [d] = await db`
        UPDATE devices SET
          hardware_id = ${register.hardware_id},
          hostname = ${register.hostname},
          version = ${register.version},
          status = 'online',
          last_seen_at = now(),
          updated_at = now(),
          verification_code = ${verificationCode}
        WHERE id = ${existing[0].id}
        RETURNING *
      `
      device = d as Device
      isNew = false
    }
  } catch (e) {
    console.error('failed to register device:', e)
    ws.close()
    return
  }

  const action = isNew ? 'device.register' : 'device.reconnect'
  await db`
    INSERT INTO audit_log (actor_type, action, target_type, target_id, details)
    VALUES ('system', ${action}, 'device', ${device.id}, ${JSON.stringify({ hostname: device.hostname, version: device.version })})
  `.catch(() => {})

  if (device.enrollment_state === 'rejected') {
    send(ws, { msg_type: 'enrollment_rejected' })
    ws.close()
    return
  }

  if (device.enrollment_state === 'pending') {
    const code = device.enrollment_code || ''
    const enrolled = await waitForEnrollment(ws, device, code, state)
    if (!enrolled) return

    const [updated] = await db`SELECT * FROM devices WHERE id = ${device.id}`
    if (!updated) return
    device = updated as Device
  }

  if (device.verification_state === 'verified') {
    send(ws, { msg_type: 'verification_approved' })
  } else if (device.verification_code) {
    const verified = await waitForVerification(ws, device, state)
    if (!verified) return
  }

  await runMainLoop(ws, device, state)
}

async function waitForEnrollment(
  ws: WebSocket,
  device: Device,
  code: string,
  state: AppState,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sub = new Redis(state.config.redis.url)
    const channel = `enrollment:${device.id}`
    let resolved = false
    let pingInterval: ReturnType<typeof setInterval>
    let codeInterval: ReturnType<typeof setInterval>

    function finish(result: boolean) {
      if (resolved) return
      resolved = true
      clearInterval(pingInterval)
      clearInterval(codeInterval)
      sub.unsubscribe().catch(() => {})
      sub.disconnect()
      ws.removeListener('close', onClose)
      resolve(result)
    }

    sub.on('message', (_ch: string, message: string) => {
      if (message === 'approved') {
        send(ws, { msg_type: 'enrollment_approved' })
        finish(true)
      } else if (message === 'rejected') {
        send(ws, { msg_type: 'enrollment_rejected' })
        finish(false)
      }
    })

    const onClose = () => finish(false)
    ws.on('close', onClose)

    sub.subscribe(channel).then(() => {
      send(ws, { msg_type: 'enrollment_pending', code, device_uuid: device.id })
      pingInterval = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping() }, 30_000)
      codeInterval = setInterval(() => {
        send(ws, { msg_type: 'enrollment_pending', code, device_uuid: device.id })
      }, 15_000)
    }).catch((e: unknown) => {
      console.error(`failed to subscribe to ${channel}:`, e)
      finish(false)
    })
  })
}

async function waitForVerification(
  ws: WebSocket,
  device: Device,
  state: AppState,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sub = new Redis(state.config.redis.url)
    const channel = `verification:${device.id}`
    let resolved = false
    let pingInterval: ReturnType<typeof setInterval>
    let reminderInterval: ReturnType<typeof setInterval>

    function finish(result: boolean) {
      if (resolved) return
      resolved = true
      clearInterval(pingInterval)
      clearInterval(reminderInterval)
      sub.unsubscribe().catch(() => {})
      sub.disconnect()
      ws.removeListener('close', onClose)
      resolve(result)
    }

    sub.on('message', (_ch: string, message: string) => {
      if (message === 'approved') {
        send(ws, { msg_type: 'verification_approved' })
        finish(true)
      }
    })

    const onClose = () => finish(false)
    ws.on('close', onClose)

    sub.subscribe(channel).then(() => {
      send(ws, { msg_type: 'verification_pending', code: device.verification_code })
      pingInterval = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping() }, 30_000)
      reminderInterval = setInterval(() => {
        send(ws, { msg_type: 'verification_pending', code: device.verification_code })
      }, 15_000)
    }).catch((e: unknown) => {
      console.error(`failed to subscribe to ${channel}:`, e)
      finish(false)
    })
  })
}

async function runMainLoop(ws: WebSocket, device: Device, state: AppState) {
  const { db, config } = state

  let token: string
  try {
    token = await generateDeviceToken(device.id, device.device_id, config.auth.jwt_secret, config.auth.device_token_ttl)
  } catch (e) {
    console.error('failed to generate device token:', e)
    ws.close()
    return
  }

  send(ws, { msg_type: 'register_response', device_id: device.device_id, auth_token: token })
  state.wsRegistry.insert(device.id, ws)

  const commandSub = new Redis(state.config.redis.url, {
    retryStrategy: (times: number) => Math.min(times * 1000, 30_000),
  })
  const commandChannel = `commands:${device.id}`
  commandSub.subscribe(commandChannel).catch((e: unknown) => {
    console.error(`failed to subscribe to ${commandChannel}:`, e)
  })
  commandSub.on('message', (_ch: string, message: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message)
  })

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping()
  }, 30_000)

  const refreshSecs = Math.max(60, config.auth.device_token_ttl - 120)
  const tokenInterval = setInterval(async () => {
    try {
      const newToken = await generateDeviceToken(device.id, device.device_id, config.auth.jwt_secret, config.auth.device_token_ttl)
      send(ws, { msg_type: 'register_response', device_id: device.device_id, auth_token: newToken })
    } catch { /* non-fatal */ }
  }, refreshSecs * 1000)

  let telemetryCounter = 0
  const dbSampleRate = config.telemetry.db_sample_rate

  ws.on('message', async (data) => {
    const text = data.toString()
    await handleTelemetryMsg(text, device, state, telemetryCounter, dbSampleRate)
    telemetryCounter = (telemetryCounter + 1) % dbSampleRate
  })

  return new Promise<void>((resolve) => {
    ws.on('close', async () => {
      console.log(`device disconnected: ${device.device_id}`)
      clearInterval(pingInterval)
      clearInterval(tokenInterval)
      commandSub.unsubscribe().catch(() => {})
      commandSub.disconnect()
      state.wsRegistry.remove(device.id)

      await db`
        UPDATE devices SET status = 'offline', last_seen_at = now(), updated_at = now()
        WHERE id = ${device.id}
      `.catch((e: unknown) => console.error('failed to set device offline:', e))
      await db`
        INSERT INTO audit_log (actor_type, action, target_type, target_id)
        VALUES ('system', 'device.disconnect', 'device', ${device.id})
      `.catch(() => {})

      resolve()
    })
  })
}

async function handleTelemetryMsg(
  text: string,
  device: Device,
  state: AppState,
  counter: number,
  dbSampleRate: number,
) {
  let report: TelemetryReport
  try {
    report = JSON.parse(text)
  } catch {
    return
  }

  const redisKey = `telemetry:${device.id}`
  await state.redis.set(redisKey, text, 'EX', 30).catch(() => {})

  await state.db`
    UPDATE devices SET last_state = ${report.state}, last_seen_at = now(), updated_at = now()
    WHERE id = ${device.id}
  `.catch(() => {})

  if (counter >= dbSampleRate - 1) {
    const ts = report.ts ? new Date(report.ts * 1000) : new Date()
    await state.db`
      INSERT INTO telemetry (device_id, ts, state, payload)
      VALUES (${device.id}, ${ts}, ${report.state}, ${JSON.stringify(report)})
    `.catch(() => {})
  }
}
