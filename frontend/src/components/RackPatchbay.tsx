/**
 * RackPatchbay — Rack list view with integrated patchbay routing.
 *
 * Combines the structured slot list of VirtualRack with the visual routing
 * of Patchbay. Sources (left) and Destinations (right) are shown as numbered
 * rack slots. SVG bezier curves connect routed slots across the center.
 *
 * Routing interaction:
 *   1. Click a source slot to select it (blue highlight)
 *   2. Click any destination slot to create a route
 *   3. Click × on a route line to remove it
 *   4. Press Escape to cancel selection
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { api, type Source, type Destination, type Route } from '../api.js'
import AddSourcePanel from './AddSourcePanel.js'
import AddDestPanel from './AddDestPanel.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  active:      '#22c55e',
  waiting:     '#eab308',
  error:       '#ef4444',
  idle:        '#475569',
  placeholder: '#2d3348',
}

const TYPE_ICON: Record<string, string> = {
  encoder:      '📡',
  srt_listen:   '🔗',
  srt_pull:     '🔗',
  rtmp_pull:    '📺',
  test_pattern: '🎨',
  placeholder:  '👻',
  rtmp:         '📺',
  srt_push:     '📡',
  hls:          '🌐',
  recorder:     '💾',
  lgl_ingest:   '🔄',
}

interface RouteLine {
  id: string
  x1: number; y1: number
  x2: number; y2: number
  isActive: boolean
  route: Route
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SlotNumber({ n }: { n: number }) {
  return (
    <span style={{
      display: 'inline-block', width: 22, textAlign: 'right',
      fontSize: 10, color: '#475569', fontVariantNumeric: 'tabular-nums',
      flexShrink: 0, userSelect: 'none',
    }}>
      {String(n).padStart(2, '0')}
    </span>
  )
}

function StatusDot({ status }: { status: string }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7,
      borderRadius: '50%', background: STATUS_COLOR[status] ?? '#475569',
      flexShrink: 0,
    }} />
  )
}

function ActionBtn({ onClick, label, color }: { onClick: () => void; label: string; color: string }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{
        background: 'transparent', border: `1px solid ${color}`,
        borderRadius: 4, padding: '2px 7px', fontSize: 11,
        color, cursor: 'pointer', lineHeight: 1.4, flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}

function ColumnHeader({ title, count, color, onAdd }: { title: string; count: number; color: string; onAdd: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '0 2px' }}>
      <div style={{ width: 3, height: 16, background: color, borderRadius: 2, flexShrink: 0 }} />
      <span style={{ fontWeight: 700, fontSize: 12, color: '#e2e8f0', textTransform: 'uppercase', letterSpacing: 1 }}>
        {title}
      </span>
      <span style={{ fontSize: 11, color: '#475569', background: '#1a1e2a', padding: '1px 6px', borderRadius: 10, border: '1px solid #2d3348' }}>
        {count}
      </span>
      <button
        onClick={onAdd}
        style={{ marginLeft: 'auto', background: `${color}20`, border: `1px solid ${color}60`, borderRadius: 4, padding: '2px 10px', color, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
      >
        + Add
      </button>
    </div>
  )
}

// ── SourceSlot ────────────────────────────────────────────────────────────────

interface SourceSlotProps {
  slot: number
  src: Source
  routes: Route[]
  selected: boolean
  onClick: () => void
  onDelete: (id: string) => void
  onStart: (id: string) => void
  onStop: (id: string) => void
  divRef: (el: HTMLDivElement | null) => void
}

function SourceSlot({ slot, src, routes, selected, onClick, onDelete, onStart, onStop, divRef }: SourceSlotProps) {
  const myRoutes = routes.filter(r => r.source_id === src.id)
  const isPlaceholder = src.source_type === 'placeholder'
  const color = STATUS_COLOR[src.status] ?? '#475569'

  return (
    <div
      ref={divRef}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px',
        background: selected ? '#162440' : '#1a1e2a',
        border: `1px solid ${selected ? '#3b82f6' : isPlaceholder ? '#2d3348' : '#2a3050'}`,
        borderStyle: isPlaceholder ? 'dashed' : 'solid',
        borderRadius: 6,
        minHeight: 44,
        cursor: isPlaceholder ? 'default' : 'pointer',
        transition: 'background 0.12s, border-color 0.12s',
        userSelect: 'none',
        boxSizing: 'border-box',
      }}
    >
      <SlotNumber n={slot} />
      <StatusDot status={src.status} />
      <span style={{ fontSize: 14, flexShrink: 0 }}>{TYPE_ICON[src.source_type] ?? '📡'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {src.name}
        </div>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', marginTop: 1 }}>
          {src.source_type.replace(/_/g, ' ')}
          {myRoutes.length > 0 && (
            <span style={{ color, marginLeft: 4 }}>
              · {myRoutes.length} route{myRoutes.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      {!isPlaceholder && (
        src.status === 'active'
          ? <ActionBtn onClick={() => onStop(src.id)} label="Stop" color="#475569" />
          : <ActionBtn onClick={() => onStart(src.id)} label="Start" color="#3b82f6" />
      )}
      <ActionBtn onClick={() => onDelete(src.id)} label="✕" color="#ef444466" />
    </div>
  )
}

// ── DestSlot ──────────────────────────────────────────────────────────────────

interface DestSlotProps {
  slot: number
  dest: Destination
  routes: Route[]
  isTarget: boolean
  onClick: () => void
  onDelete: (id: string) => void
  onStart: (id: string) => void
  onStop: (id: string) => void
  divRef: (el: HTMLDivElement | null) => void
}

function DestSlot({ slot, dest, routes, isTarget, onClick, onDelete, onStart, onStop, divRef }: DestSlotProps) {
  const myRoutes = routes.filter(r => r.dest_id === dest.id)
  const isPlaceholder = dest.dest_type === 'placeholder'
  const color = STATUS_COLOR[dest.status] ?? '#475569'

  return (
    <div
      ref={divRef}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px',
        background: isTarget ? '#0a2218' : '#1a1e2a',
        border: `1px solid ${isTarget ? '#10b981' : isPlaceholder ? '#2d3348' : '#1a3040'}`,
        borderStyle: isPlaceholder ? 'dashed' : 'solid',
        borderRadius: 6,
        minHeight: 44,
        cursor: isTarget ? 'crosshair' : 'default',
        transition: 'background 0.12s, border-color 0.12s',
        userSelect: 'none',
        boxSizing: 'border-box',
      }}
    >
      <SlotNumber n={slot} />
      <StatusDot status={dest.status} />
      <span style={{ fontSize: 14, flexShrink: 0 }}>{TYPE_ICON[dest.dest_type] ?? '📺'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 12, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {dest.name}
        </div>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', marginTop: 1 }}>
          {dest.dest_type.replace(/_/g, ' ')}
          {myRoutes.length > 0 && (
            <span style={{ color, marginLeft: 4 }}>
              · {myRoutes.length} source{myRoutes.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      {!isPlaceholder && (
        dest.status === 'active'
          ? <ActionBtn onClick={() => onStop(dest.id)} label="Stop" color="#475569" />
          : <ActionBtn onClick={() => onStart(dest.id)} label="Start" color="#047857" />
      )}
      <ActionBtn onClick={() => onDelete(dest.id)} label="✕" color="#ef444466" />
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RackPatchbay() {
  const [sources, setSources] = useState<Source[]>([])
  const [dests, setDests] = useState<Destination[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddSource, setShowAddSource] = useState(false)
  const [showAddDest, setShowAddDest] = useState(false)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [routeLines, setRouteLines] = useState<RouteLine[]>([])

  // Refs for position measurement
  const mainRef = useRef<HTMLDivElement>(null)
  const leftColRef = useRef<HTMLDivElement>(null)
  const rightColRef = useRef<HTMLDivElement>(null)
  const sourceRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const destRowRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // ── Data loading ────────────────────────────────────────────────────────────

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

  // ── SVG route line calculation ──────────────────────────────────────────────

  const recalcLines = useCallback((currentRoutes: Route[]) => {
    const mainEl = mainRef.current
    if (!mainEl) return
    const mainRect = mainEl.getBoundingClientRect()

    const lines: RouteLine[] = []
    for (const route of currentRoutes) {
      const srcEl = sourceRowRefs.current[route.source_id]
      const dstEl = destRowRefs.current[route.dest_id]
      if (!srcEl || !dstEl) continue

      const srcRect = srcEl.getBoundingClientRect()
      const dstRect = dstEl.getBoundingClientRect()

      lines.push({
        id: route.id,
        x1: srcRect.right - mainRect.left,
        y1: srcRect.top - mainRect.top + srcRect.height / 2,
        x2: dstRect.left - mainRect.left,
        y2: dstRect.top - mainRect.top + dstRect.height / 2,
        isActive: route.source_status === 'active',
        route,
      })
    }
    setRouteLines(lines)
  }, [])

  // Recalculate after data changes (wait for DOM update)
  useEffect(() => {
    const frame = requestAnimationFrame(() => recalcLines(routes))
    return () => cancelAnimationFrame(frame)
  }, [routes, recalcLines])

  // Recalculate on scroll and resize
  useEffect(() => {
    const update = () => recalcLines(routes)
    const leftCol = leftColRef.current
    const rightCol = rightColRef.current
    window.addEventListener('resize', update)
    leftCol?.addEventListener('scroll', update)
    rightCol?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      leftCol?.removeEventListener('scroll', update)
      rightCol?.removeEventListener('scroll', update)
    }
  }, [routes, recalcLines])

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleDeleteRoute = useCallback(async (routeId: string) => {
    try {
      await api.deleteRoute(routeId)
      setRoutes(rs => rs.filter(r => r.id !== routeId))
    } catch (e) { console.error(e) }
  }, [])

  const handleSourceClick = useCallback((src: Source) => {
    if (src.source_type === 'placeholder') return
    setSelectedSourceId(id => id === src.id ? null : src.id)
  }, [])

  const handleDestClick = useCallback(async (dest: Destination) => {
    if (!selectedSourceId || dest.dest_type === 'placeholder') return
    try {
      const route = await api.createRoute(selectedSourceId, dest.id)
      setRoutes(rs => [...rs, route])
    } catch (e) {
      console.error('failed to create route:', e)
    } finally {
      setSelectedSourceId(null)
    }
  }, [selectedSourceId])

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

  // ESC to cancel source selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedSourceId(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading rack...</div>

  const activeSources = sources.filter(s => s.status === 'active').length
  const activeDests = dests.filter(d => d.status === 'active').length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0f1117' }}>

      {/* Stats / hint bar */}
      <div style={{
        padding: '6px 20px', background: '#141722', borderBottom: '1px solid #2d3348',
        display: 'flex', gap: 16, alignItems: 'center', minHeight: 36,
      }}>
        {selectedSourceId ? (
          <span style={{ fontSize: 12, color: '#3b82f6', fontWeight: 600 }}>
            Source selected — click a destination to route · <span style={{ fontWeight: 400, color: '#64748b' }}>Esc to cancel</span>
          </span>
        ) : (
          <>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              <span style={{ color: '#22c55e', fontWeight: 600 }}>{activeSources}</span>/{sources.length} sources active
            </span>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              <span style={{ color: '#22c55e', fontWeight: 600 }}>{activeDests}</span>/{dests.length} destinations active
            </span>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              <span style={{ color: '#94a3b8', fontWeight: 600 }}>{routes.length}</span> routes
            </span>
            <span style={{ fontSize: 11, color: '#334155', marginLeft: 'auto' }}>
              Click a source to start routing
            </span>
          </>
        )}
      </div>

      {/* Main rack area */}
      <div ref={mainRef} style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex' }}>

        {/* Sources column */}
        <div
          ref={leftColRef}
          style={{ flex: 1, overflowY: 'auto', padding: '16px 12px 20px 16px', borderRight: '1px solid #1e2130' }}
        >
          <ColumnHeader title="Sources" count={sources.length} color="#3b82f6" onAdd={() => setShowAddSource(true)} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {sources.length === 0 && (
              <div style={{ padding: '24px 0', textAlign: 'center', color: '#475569', fontSize: 12 }}>
                No sources — add one above
              </div>
            )}
            {sources.map((src, i) => (
              <SourceSlot
                key={src.id}
                slot={i + 1}
                src={src}
                routes={routes}
                selected={selectedSourceId === src.id}
                onClick={() => handleSourceClick(src)}
                onDelete={handleDeleteSource}
                onStart={handleStartSource}
                onStop={handleStopSource}
                divRef={el => { sourceRowRefs.current[src.id] = el }}
              />
            ))}
          </div>
        </div>

        {/* Destinations column */}
        <div
          ref={rightColRef}
          style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 20px 12px' }}
        >
          <ColumnHeader title="Destinations" count={dests.length} color="#047857" onAdd={() => setShowAddDest(true)} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {dests.length === 0 && (
              <div style={{ padding: '24px 0', textAlign: 'center', color: '#475569', fontSize: 12 }}>
                No destinations — add one above
              </div>
            )}
            {dests.map((dest, i) => (
              <DestSlot
                key={dest.id}
                slot={i + 1}
                dest={dest}
                routes={routes}
                isTarget={!!selectedSourceId && dest.dest_type !== 'placeholder'}
                onClick={() => handleDestClick(dest)}
                onDelete={handleDeleteDest}
                onStart={handleStartDest}
                onStop={handleStopDest}
                divRef={el => { destRowRefs.current[dest.id] = el }}
              />
            ))}
          </div>
        </div>

        {/* SVG route lines */}
        <svg
          style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            pointerEvents: 'none', overflow: 'visible',
          }}
        >
          <defs>
            <filter id="glow-active">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {routeLines.map(line => {
            const curve = 48
            const path = `M ${line.x1} ${line.y1} C ${line.x1 + curve} ${line.y1}, ${line.x2 - curve} ${line.y2}, ${line.x2} ${line.y2}`
            const color = line.isActive ? '#22c55e' : '#475569'
            return (
              <path
                key={line.id}
                d={path}
                stroke={color}
                strokeWidth={line.isActive ? 2 : 1.5}
                fill="none"
                strokeDasharray={line.isActive ? undefined : '5 4'}
                opacity={line.isActive ? 0.85 : 0.5}
                filter={line.isActive ? 'url(#glow-active)' : undefined}
              />
            )
          })}
        </svg>

        {/* Route delete buttons */}
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {routeLines.map(line => {
            const mx = (line.x1 + line.x2) / 2
            const my = (line.y1 + line.y2) / 2
            return (
              <button
                key={line.id}
                onClick={() => handleDeleteRoute(line.id)}
                title="Remove route"
                style={{
                  position: 'absolute',
                  left: mx,
                  top: my,
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: 'all',
                  background: '#141722',
                  border: `1px solid ${line.isActive ? '#22c55e40' : '#2d3348'}`,
                  borderRadius: '50%',
                  width: 18,
                  height: 18,
                  fontSize: 11,
                  color: '#64748b',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            )
          })}
        </div>
      </div>

      {showAddSource && (
        <AddSourcePanel
          onClose={() => setShowAddSource(false)}
          onAdded={src => { setSources(s => [...s, src]); setShowAddSource(false) }}
        />
      )}
      {showAddDest && (
        <AddDestPanel
          onClose={() => setShowAddDest(false)}
          onAdded={dest => { setDests(d => [...d, dest]); setShowAddDest(false) }}
        />
      )}
    </div>
  )
}
