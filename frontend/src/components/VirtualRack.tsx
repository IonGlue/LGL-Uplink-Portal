/**
 * VirtualRack — structured list view of sources and destinations.
 *
 * Shows sources (left column) and destinations (right column) as numbered
 * rack slots, similar to a physical broadcast patchbay panel. Routes are
 * shown as colored badges on each slot.
 *
 * Complements the free-form Patchbay canvas for operators who prefer a
 * structured, top-to-bottom slot layout.
 */
import { useEffect, useState, useCallback } from 'react'
import { api, type Source, type Destination, type Route } from '../api.js'
import AddSourcePanel from './AddSourcePanel.js'
import AddDestPanel from './AddDestPanel.js'

// ── Status helpers ──────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  active: '#22c55e',
  waiting: '#eab308',
  error: '#ef4444',
  idle: '#475569',
  placeholder: '#2d3348',
}

const TYPE_ICON: Record<string, string> = {
  encoder: '📡',
  srt_listen: '🔗',
  srt_pull: '🔗',
  rtmp_pull: '📺',
  test_pattern: '🎨',
  placeholder: '👻',
  rtmp: '📺',
  srt_push: '📡',
  hls: '🌐',
  recorder: '💾',
  lgl_ingest: '🔄',
}

function dot(status: string) {
  const color = STATUS_DOT[status] ?? '#475569'
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8,
      borderRadius: '50%', background: color, flexShrink: 0,
    }} />
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function SlotNumber({ n }: { n: number }) {
  return (
    <span style={{
      display: 'inline-block', width: 28, textAlign: 'right',
      fontSize: 11, color: '#475569', fontVariantNumeric: 'tabular-nums',
      flexShrink: 0, userSelect: 'none',
    }}>
      {String(n).padStart(2, '0')}
    </span>
  )
}

interface SourceRowProps {
  slot: number
  src: Source
  routes: Route[]
  onDelete: (id: string) => void
  onStart: (id: string) => void
  onStop: (id: string) => void
}

function SourceRow({ slot, src, routes, onDelete, onStart, onStop }: SourceRowProps) {
  const myRoutes = routes.filter(r => r.source_id === src.id)
  const isPlaceholder = src.source_type === 'placeholder'
  const dotColor = STATUS_DOT[src.status] ?? '#475569'
  const icon = TYPE_ICON[src.source_type] ?? '📡'
  const isActive = src.status === 'active'

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px',
      background: '#1a1e2a',
      border: `1px solid ${isPlaceholder ? '#2d3348' : '#2a3050'}`,
      borderStyle: isPlaceholder ? 'dashed' : 'solid',
      borderRadius: 6,
      minHeight: 48,
    }}>
      <SlotNumber n={slot} />
      {dot(src.status)}
      <span style={{ fontSize: 15, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {src.name}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 1 }}>
          <span style={{ textTransform: 'uppercase' }}>{src.source_type.replace('_', ' ')}</span>
          {src.device_id && <span style={{ color: '#475569' }}>↔ {src.device_id.slice(0, 16)}</span>}
          {src.internal_port && <span>:{src.internal_port}</span>}
        </div>
      </div>

      {/* Route badges */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 160 }}>
        {myRoutes.map(r => (
          <span key={r.id} style={{
            fontSize: 10, padding: '2px 7px', borderRadius: 10,
            background: dotColor + '20', color: dotColor,
            border: `1px solid ${dotColor}40`,
            whiteSpace: 'nowrap',
          }}>
            → {r.dest_name}
          </span>
        ))}
        {myRoutes.length === 0 && !isPlaceholder && (
          <span style={{ fontSize: 10, color: '#2d3348' }}>unrouted</span>
        )}
      </div>

      {/* Actions */}
      {!isPlaceholder && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {isActive ? (
            <ActionBtn onClick={() => onStop(src.id)} label="Stop" color="#64748b" />
          ) : (
            <ActionBtn onClick={() => onStart(src.id)} label="Start" color="#3b82f6" />
          )}
        </div>
      )}
      <ActionBtn onClick={() => onDelete(src.id)} label="✕" color="#ef444480" />
    </div>
  )
}

interface DestRowProps {
  slot: number
  dest: Destination
  routes: Route[]
  onDelete: (id: string) => void
  onStart: (id: string) => void
  onStop: (id: string) => void
}

function DestRow({ slot, dest, routes, onDelete, onStart, onStop }: DestRowProps) {
  const myRoutes = routes.filter(r => r.dest_id === dest.id)
  const isPlaceholder = dest.dest_type === 'placeholder'
  const icon = TYPE_ICON[dest.dest_type] ?? '📺'
  const isActive = dest.status === 'active'
  const dotColor = STATUS_DOT[dest.status] ?? '#475569'

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px',
      background: '#1a1e2a',
      border: `1px solid ${isPlaceholder ? '#2d3348' : '#1a3040'}`,
      borderStyle: isPlaceholder ? 'dashed' : 'solid',
      borderRadius: 6,
      minHeight: 48,
    }}>
      <SlotNumber n={slot} />
      {dot(dest.status)}
      <span style={{ fontSize: 15, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {dest.name}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginTop: 1 }}>
          {dest.dest_type.replace('_', ' ')}
        </div>
      </div>

      {/* Route badges */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 160 }}>
        {myRoutes.map(r => (
          <span key={r.id} style={{
            fontSize: 10, padding: '2px 7px', borderRadius: 10,
            background: dotColor + '20', color: dotColor,
            border: `1px solid ${dotColor}40`,
            whiteSpace: 'nowrap',
          }}>
            {r.source_name} →
          </span>
        ))}
        {myRoutes.length === 0 && !isPlaceholder && (
          <span style={{ fontSize: 10, color: '#2d3348' }}>unrouted</span>
        )}
      </div>

      {/* Actions */}
      {!isPlaceholder && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {isActive ? (
            <ActionBtn onClick={() => onStop(dest.id)} label="Stop" color="#64748b" />
          ) : (
            <ActionBtn onClick={() => onStart(dest.id)} label="Start" color="#047857" />
          )}
        </div>
      )}
      <ActionBtn onClick={() => onDelete(dest.id)} label="✕" color="#ef444480" />
    </div>
  )
}

function ActionBtn({ onClick, label, color }: { onClick: () => void; label: string; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent', border: `1px solid ${color}`,
        borderRadius: 4, padding: '3px 8px', fontSize: 11,
        color, cursor: 'pointer', lineHeight: 1.4,
      }}
    >
      {label}
    </button>
  )
}

// ── Rack column header ───────────────────────────────────────────────────────

function ColumnHeader({ title, count, color, onAdd }: { title: string; count: number; color: string; onAdd: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <div style={{ width: 3, height: 18, background: color, borderRadius: 2, flexShrink: 0 }} />
      <span style={{ fontWeight: 700, fontSize: 13, color: '#e2e8f0', textTransform: 'uppercase', letterSpacing: 1 }}>{title}</span>
      <span style={{ fontSize: 11, color: '#475569', background: '#1a1e2a', padding: '1px 7px', borderRadius: 10, border: '1px solid #2d3348' }}>{count}</span>
      <button
        onClick={onAdd}
        style={{ marginLeft: 'auto', background: color + '20', border: `1px solid ${color}60`, borderRadius: 4, padding: '3px 10px', color, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
      >
        + Add
      </button>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function VirtualRack() {
  const [sources, setSources] = useState<Source[]>([])
  const [dests, setDests] = useState<Destination[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddSource, setShowAddSource] = useState(false)
  const [showAddDest, setShowAddDest] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, d, r] = await Promise.all([api.getSources(), api.getDests(), api.getRoutes()])
      setSources(s)
      setDests(d)
      setRoutes(r)
    } catch (e) {
      console.error('failed to load rack:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [load])

  async function handleDeleteSource(id: string) {
    try {
      await api.deleteSource(id)
      setSources(s => s.filter(x => x.id !== id))
      setRoutes(r => r.filter(x => x.source_id !== id))
    } catch (e) { console.error(e) }
  }

  async function handleDeleteDest(id: string) {
    try {
      await api.deleteDest(id)
      setDests(d => d.filter(x => x.id !== id))
      setRoutes(r => r.filter(x => x.dest_id !== id))
    } catch (e) { console.error(e) }
  }

  async function handleStartSource(id: string) {
    try { await api.startSource(id); load() } catch (e) { console.error(e) }
  }
  async function handleStopSource(id: string) {
    try { await api.stopSource(id); load() } catch (e) { console.error(e) }
  }
  async function handleStartDest(id: string) {
    try { await api.startDest(id); load() } catch (e) { console.error(e) }
  }
  async function handleStopDest(id: string) {
    try { await api.stopDest(id); load() } catch (e) { console.error(e) }
  }

  // Stats
  const activeSources = sources.filter(s => s.status === 'active').length
  const activeDests = dests.filter(d => d.status === 'active').length

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading rack...</div>

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0f1117' }}>
      {/* Stats bar */}
      <div style={{ padding: '8px 20px', background: '#141722', borderBottom: '1px solid #2d3348', display: 'flex', gap: 20, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>{activeSources}</span>/{sources.length} sources active
        </span>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>{activeDests}</span>/{dests.length} destinations active
        </span>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          <span style={{ color: '#94a3b8', fontWeight: 600 }}>{routes.length}</span> routes
        </span>
      </div>

      {/* Rack columns */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, overflow: 'hidden' }}>

        {/* Sources column */}
        <div style={{ borderRight: '1px solid #1e2130', overflow: 'auto', padding: '20px 16px 20px 20px' }}>
          <ColumnHeader
            title="Sources"
            count={sources.length}
            color="#3b82f6"
            onAdd={() => setShowAddSource(true)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sources.length === 0 && (
              <div style={{ padding: '24px 0', textAlign: 'center', color: '#475569', fontSize: 13 }}>
                No sources yet — add one above
              </div>
            )}
            {sources.map((src, i) => (
              <SourceRow
                key={src.id}
                slot={i + 1}
                src={src}
                routes={routes}
                onDelete={handleDeleteSource}
                onStart={handleStartSource}
                onStop={handleStopSource}
              />
            ))}
          </div>
        </div>

        {/* Destinations column */}
        <div style={{ overflow: 'auto', padding: '20px 20px 20px 16px' }}>
          <ColumnHeader
            title="Destinations"
            count={dests.length}
            color="#047857"
            onAdd={() => setShowAddDest(true)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {dests.length === 0 && (
              <div style={{ padding: '24px 0', textAlign: 'center', color: '#475569', fontSize: 13 }}>
                No destinations yet — add one above
              </div>
            )}
            {dests.map((dest, i) => (
              <DestRow
                key={dest.id}
                slot={i + 1}
                dest={dest}
                routes={routes}
                onDelete={handleDeleteDest}
                onStart={handleStartDest}
                onStop={handleStopDest}
              />
            ))}
          </div>
        </div>
      </div>

      {showAddSource && (
        <AddSourcePanel onClose={() => setShowAddSource(false)} onAdded={src => { setSources(s => [...s, src]); setShowAddSource(false) }} />
      )}
      {showAddDest && (
        <AddDestPanel onClose={() => setShowAddDest(false)} onAdded={dest => { setDests(d => [...d, dest]); setShowAddDest(false) }} />
      )}
    </div>
  )
}
