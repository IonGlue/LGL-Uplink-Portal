import { WebSocket } from 'ws'
import Redis from 'ioredis'
import type { AppState, Device, TelemetryReport } from '../types.js'
import { generateDeviceToken } from '../auth/jwt.js'

function send(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}


function waitForMessage(ws: WebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, timeoutMs)

    const onMessage = (data: Buffer | string) => {
      cleanup()
      resolve(data.toString())
    }
    const onClose = () => {
      cleanup()
      reject(new Error('closed'))
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }

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

  // 1. Wait for registration message (10s timeout)
  let firstMsg: string
  try {
    firstMsg = await waitForMessage(ws, 10_000)
  } catch {
    console.warn('device did not send registration in time')
    ws.close()
    return
  }

  let register: { msg_type: string; device_id: string; hardware_id: string; hostname: string; version: string; verification_code?: string }
  try {
    register = JSON.parse(firstMsg)
    if (register.msg_type !== 'register') throw new Error('unexpected')
  } catch {
    console.warn('device sent unexpected first message')
    ws.close()
    return
  }

  console.log(`device registering: ${register.device_id}`)

  // 2. Register or update device in DB
  let device: Device
  let isNew: boolean
  try {
    const existing = await db`
      SELECT * FROM devices WHERE device_id = ${register.device_id}
    `
    const verificationCode = register.verification_code?.toUpperCase() ?? null
    if (existing.length === 0) {
      // Use the first 10 characters of the device-id as the enrollment code.
      // On Linux this is derived from /etc/machine-id, so the admin can
      // confirm the code by looking at the device's machine-id.
      const code = register.device_id.slice(0, 10).toUpperCase()
      const [d] = await db`
        INSERT INTO devices (device_id, hardware_id, hostname, version, status, last_seen_at, enrollment_state, enrollment_code, verification_code, verification_state)
        VALUES (${register.device_id}, ${register.hardware_id}, ${register.hostname}, ${register.version}, 'online', now(), 'pending', ${code}, ${verificationCode}, 'unverified')
        RETURNING *
      `
      device = d as Device
      isNew = true
    } else if (existing[0].archived) {
      // Archived device reconnecting — reset to fresh pending state so it goes
      // through the new-connection workflow again rather than silently resuming.
      const code = register.device_id.slice(0, 10).toUpperCase()
      const [d] = await db`
        UPDATE devices SET
          hardware_id = ${register.hardware_id},
          hostname = ${register.hostname},
          version = ${register.version},
          status = 'online',
          last_seen_at = now(),
          updated_at = now(),
          archived = false,
          org_id = NULL,
          enrollment_state = 'pending',
          enrollment_code = ${code},
          enrolled_at = NULL,
          enrolled_by = NULL,
          verification_code = ${verificationCode},
          verification_state = 'unverified',
          verified_at = NULL,
          verified_by = NULL
        WHERE id = ${existing[0].id}
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

  // 3. Audit log
  const action = isNew ? 'device.register' : 'device.reconnect'
  await db`
    INSERT INTO audit_log (actor_type, action, target_type, target_id, details)
    VALUES ('system', ${action}, 'device', ${device.id}, ${JSON.stringify({ hostname: device.hostname, version: device.version })})
  `.catch(() => {})

  // 4. Check enrollment state
  if (device.enrollment_state === 'rejected') {
    console.warn(`rejected device attempted to connect: ${device.device_id}`)
    send(ws, { msg_type: 'enrollment_rejected' })
    ws.close()
    return
  }

  if (device.enrollment_state === 'pending') {
    console.log(`device in pending enrollment state: ${device.device_id}`)
    const code = device.enrollment_code || ''
    // waitForEnrollment sets up Redis sub first, then sends enrollment_pending
    const enrolled = await waitForEnrollment(ws, device, code, state)
    if (!enrolled) return

    // Re-fetch device
    const [updated] = await db`SELECT * FROM devices WHERE id = ${device.id}`
    if (!updated) return
    device = updated as Device
  }

  // Enrolled — check verification state
  if (device.verification_state === 'verified') {
    // Already verified — tell the device so it can clear the code from its screen
    send(ws, { msg_type: 'verification_approved' })
  } else if (device.verification_code) {
    // Needs verification — wait for admin to enter the code shown on device
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
        console.log(`enrollment approved: ${device.device_id}`)
        send(ws, { msg_type: 'enrollment_approved' })
        finish(true)
      } else if (message === 'rejected') {
        console.log(`enrollment rejected: ${device.device_id}`)
        send(ws, { msg_type: 'enrollment_rejected' })
        finish(false)
      }
    })

    const onClose = () => {
      console.log(`device disconnected during enrollment: ${device.device_id}`)
      finish(false)
    }
    ws.on('close', onClose)

    // Subscribe FIRST, then send enrollment_pending so the admin can't approve before we're listening
    sub.subscribe(channel).then(() => {
      // Now safe to notify the device (and indirectly the admin UI)
      send(ws, { msg_type: 'enrollment_pending', code, device_uuid: device.id })

      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping()
          state.db`UPDATE devices SET last_seen_at = now() WHERE id = ${device.id}`.catch(() => {})
        }
      }, 30_000)

      codeInterval = setInterval(() => {
        send(ws, { msg_type: 'enrollment_pending', code, device_uuid: device.id })
      }, 15_000)
    }).catch((e) => {
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
        console.log(`device verified: ${device.device_id}`)
        send(ws, { msg_type: 'verification_approved' })
        finish(true)
      }
    })

    const onClose = () => {
      console.log(`device disconnected during verification: ${device.device_id}`)
      finish(false)
    }
    ws.on('close', onClose)

    // Subscribe first, then notify device so admin approval can't race us
    sub.subscribe(channel).then(() => {
      send(ws, { msg_type: 'verification_pending', code: device.verification_code })

      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping()
          state.db`UPDATE devices SET last_seen_at = now() WHERE id = ${device.id}`.catch(() => {})
        }
      }, 30_000)

      // Resend reminder every 15s in case the device missed it
      reminderInterval = setInterval(() => {
        send(ws, { msg_type: 'verification_pending', code: device.verification_code })
      }, 15_000)
    }).catch((e) => {
      console.error(`failed to subscribe to ${channel}:`, e)
      finish(false)
    })
  })
}

async function runMainLoop(ws: WebSocket, device: Device, state: AppState) {
  const { db, config } = state

  // Generate JWT and send register_response
  let token: string
  try {
    token = await generateDeviceToken(device.id, device.device_id, config.auth.jwt_secret, config.auth.device_token_ttl)
  } catch (e) {
    console.error('failed to generate device token:', e)
    ws.close()
    return
  }

  send(ws, { msg_type: 'register_response', device_id: device.device_id, auth_token: token })

  // Register in WS registry
  state.wsRegistry.insert(device.id, ws)

  // Subscribe to command channel via Redis (with reconnect)
  const commandSub = new Redis(state.config.redis.url, {
    retryStrategy: (times) => Math.min(times * 1000, 30_000),
  })
  const commandChannel = `commands:${device.id}`
  commandSub.subscribe(commandChannel).catch((e) => {
    console.error(`failed to subscribe to ${commandChannel}:`, e)
  })
  commandSub.on('message', (_ch: string, message: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  })

  // Ping interval
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping()
  }, 30_000)

  // Token refresh interval
  const refreshSecs = Math.max(60, config.auth.device_token_ttl - 120)
  const tokenInterval = setInterval(async () => {
    try {
      const newToken = await generateDeviceToken(
        device.id,
        device.device_id,
        config.auth.jwt_secret,
        config.auth.device_token_ttl,
      )
      send(ws, { msg_type: 'register_response', device_id: device.device_id, auth_token: newToken })
    } catch {
      // Token refresh failure is non-fatal
    }
  }, refreshSecs * 1000)

  // Handle incoming telemetry messages
  let telemetryCounter = 0
  let telemetryReceived = 0
  const dbSampleRate = config.telemetry.db_sample_rate

  ws.on('message', async (data) => {
    const text = data.toString()
    telemetryReceived++
    if (telemetryReceived === 1) {
      console.log(`first telemetry message from device ${device.device_id} (${text.length} bytes)`)
    }
    await handleTelemetryMsg(text, device, state, telemetryCounter, dbSampleRate)
    telemetryCounter++
    if (telemetryCounter >= dbSampleRate) telemetryCounter = 0
  })

  // Cleanup on disconnect
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
  } catch (e) {
    const snippet = text.slice(0, 300)
    console.warn(`telemetry parse error for ${device.device_id}: ${e} — raw: ${snippet}`)
    return
  }

  // Update Redis live cache (30s TTL)
  const redisKey = `telemetry:${device.id}`
  try {
    await state.redis.set(redisKey, text, 'EX', 30)
  } catch (e) {
    console.warn(`failed to write telemetry to Redis for ${device.device_id}:`, e)
  }

  // Update device last_state
  await state.db`
    UPDATE devices SET last_state = ${report.state}, last_seen_at = now(), updated_at = now()
    WHERE id = ${device.id}
  `.catch((e: unknown) => console.warn(`failed to update device state: ${e}`))

  // Periodically persist to DB
  if (counter >= dbSampleRate - 1) {
    const ts = report.ts ? new Date(report.ts * 1000) : new Date()
    const payload = JSON.stringify(report)
    await state.db`
      INSERT INTO telemetry (device_id, ts, state, payload)
      VALUES (${device.id}, ${ts}, ${report.state}, ${payload})
    `.catch((e: unknown) => console.warn(`failed to persist telemetry: ${e}`))
  }
}
