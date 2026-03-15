import type { WebSocket } from 'ws'

export class WsRegistry {
  private connections = new Map<string, WebSocket>()

  insert(deviceId: string, ws: WebSocket) {
    this.connections.set(deviceId, ws)
  }

  remove(deviceId: string) {
    this.connections.delete(deviceId)
  }

  isConnected(deviceId: string): boolean {
    return this.connections.has(deviceId)
  }

  send(deviceId: string, msg: string): boolean {
    const ws = this.connections.get(deviceId)
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(msg)
      return true
    }
    return false
  }

  connectedCount(): number {
    return this.connections.size
  }
}
