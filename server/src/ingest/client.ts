// HTTP client for the ingest-supervisor local REST API (127.0.0.1:9000)

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
  listSources() { return this.request<unknown[]>('GET', '/sources') }
  getSource(id: string) { return this.request<unknown>('GET', `/sources/${id}`) }
  createSource(data: unknown) { return this.request<unknown>('POST', '/sources', data) }
  deleteSource(id: string) { return this.request<void>('DELETE', `/sources/${id}`) }
  startSource(id: string) { return this.request<unknown>('POST', `/sources/${id}/start`) }
  stopSource(id: string) { return this.request<unknown>('POST', `/sources/${id}/stop`) }

  // Destinations
  listDests() { return this.request<unknown[]>('GET', '/dests') }
  getDest(id: string) { return this.request<unknown>('GET', `/dests/${id}`) }
  createDest(data: unknown) { return this.request<unknown>('POST', '/dests', data) }
  deleteDest(id: string) { return this.request<void>('DELETE', `/dests/${id}`) }
  startDest(id: string) { return this.request<unknown>('POST', `/dests/${id}/start`) }
  stopDest(id: string) { return this.request<unknown>('POST', `/dests/${id}/stop`) }

  // Routes
  listRoutes() { return this.request<unknown[]>('GET', '/routes') }
  createRoute(data: { source_id: string; dest_id: string }) {
    return this.request<unknown>('POST', '/routes', data)
  }
  deleteRoute(id: string) { return this.request<void>('DELETE', `/routes/${id}`) }
}
