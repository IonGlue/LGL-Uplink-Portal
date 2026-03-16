const BASE = '/api'

function getToken() {
  return localStorage.getItem('token') ?? ''
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((err as { error: string }).error ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ token: string; user: unknown }>('POST', '/auth/login', { email, password }),
  me: () => request<{ id: string; email: string; role: string; display_name: string }>('GET', '/auth/me'),

  // Sources
  getSources: () => request<Source[]>('GET', '/sources'),
  createSource: (data: unknown) => request<Source>('POST', '/sources', data),
  updateSource: (id: string, data: unknown) => request<Source>('PATCH', `/sources/${id}`, data),
  deleteSource: (id: string) => request<void>('DELETE', `/sources/${id}`),
  startSource: (id: string) => request<unknown>('POST', `/sources/${id}/start`),
  stopSource: (id: string) => request<unknown>('POST', `/sources/${id}/stop`),

  // Destinations
  getDests: () => request<Destination[]>('GET', '/destinations'),
  createDest: (data: unknown) => request<Destination>('POST', '/destinations', data),
  updateDest: (id: string, data: unknown) => request<Destination>('PATCH', `/destinations/${id}`, data),
  deleteDest: (id: string) => request<void>('DELETE', `/destinations/${id}`),
  startDest: (id: string) => request<unknown>('POST', `/destinations/${id}/start`),
  stopDest: (id: string) => request<unknown>('POST', `/destinations/${id}/stop`),

  // Routing
  getRoutes: () => request<Route[]>('GET', '/routing'),
  createRoute: (source_id: string, dest_id: string) =>
    request<Route>('POST', '/routing', { source_id, dest_id }),
  deleteRoute: (id: string) => request<void>('DELETE', `/routing/${id}`),

  // Devices
  getDevices: () => request<Device[]>('GET', '/devices'),

  // System
  getStats: () => request<unknown>('GET', '/system/stats'),
}

export interface Source {
  id: string
  name: string
  source_type: string
  device_id: string | null
  config: Record<string, unknown>
  internal_port: number | null
  status: string
  position_x: number
  position_y: number
  created_at: string
}

export interface Destination {
  id: string
  name: string
  dest_type: string
  config: Record<string, unknown>
  status: string
  position_x: number
  position_y: number
  created_at: string
}

export interface Device {
  id: string
  device_id: string
  hardware_id: string | null
  hostname: string | null
  nickname: string | null
  version: string | null
  status: string
  enrollment_state: string
  verification_state: string
  last_seen_at: string | null
}

export interface Route {
  id: string
  source_id: string
  dest_id: string
  enabled: boolean
  source_name: string
  dest_name: string
  source_status: string
  dest_status: string
  created_at: string
}
