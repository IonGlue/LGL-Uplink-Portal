// HTTP client for the ingest-supervisor local REST API (127.0.0.1:9000)

export interface SupervisorSource {
  id: string
  name: string
  source_type: string
  config: unknown
  internal_port: number | null
  status: string
  process_pid: number | null
  position_x: number
  position_y: number
}

export interface SupervisorDest {
  id: string
  name: string
  dest_type: string
  config: unknown
  status: string
  process_pid: number | null
  position_x: number
  position_y: number
}

export interface SupervisorSyncGroupStartResult {
  started: boolean
  aligned_ports: Record<string, number>
}

export class IngestClient {
  constructor(private baseUrl: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ingest-supervisor ${method} ${path} → ${res.status}: ${text}`)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  // Sources
  listSources() { return this.request<{ sources: SupervisorSource[] }>('GET', '/sources') }
  getSource(id: string) { return this.request<SupervisorSource>('GET', `/sources/${id}`) }
  createSource(data: unknown) { return this.request<SupervisorSource>('POST', '/sources', data) }
  deleteSource(id: string) { return this.request<void>('DELETE', `/sources/${id}`) }
  startSource(id: string) { return this.request<unknown>('POST', `/sources/${id}/start`) }
  stopSource(id: string) { return this.request<unknown>('POST', `/sources/${id}/stop`) }

  // Destinations
  listDests() { return this.request<{ dests: SupervisorDest[] }>('GET', '/dests') }
  getDest(id: string) { return this.request<SupervisorDest>('GET', `/dests/${id}`) }
  createDest(data: unknown) { return this.request<SupervisorDest>('POST', '/dests', data) }
  deleteDest(id: string) { return this.request<void>('DELETE', `/dests/${id}`) }
  startDest(id: string) { return this.request<unknown>('POST', `/dests/${id}/start`) }
  stopDest(id: string) { return this.request<unknown>('POST', `/dests/${id}/stop`) }

  // Routes
  listRoutes() { return this.request<{ routes: unknown[] }>('GET', '/routes') }
  createRoute(data: { source_id: string; dest_id: string }) {
    return this.request<unknown>('POST', '/routes', data)
  }
  deleteRoute(id: string) { return this.request<void>('DELETE', `/routes/${id}`) }

  // Sync groups
  listSyncGroups() { return this.request<unknown>('GET', '/sync-groups') }
  getSyncGroup(id: string) { return this.request<unknown>('GET', `/sync-groups/${id}`) }
  createSyncGroup(data: unknown) { return this.request<unknown>('POST', '/sync-groups', data) }
  updateSyncGroup(id: string, data: unknown) { return this.request<unknown>('PUT', `/sync-groups/${id}`, data) }
  deleteSyncGroup(id: string) { return this.request<void>('DELETE', `/sync-groups/${id}`) }
  startSyncGroup(id: string) { return this.request<SupervisorSyncGroupStartResult>('POST', `/sync-groups/${id}/start`) }
  stopSyncGroup(id: string) { return this.request<unknown>('POST', `/sync-groups/${id}/stop`) }
  syncGroupStatus(id: string) { return this.request<unknown>('GET', `/sync-groups/${id}/status`) }
}
