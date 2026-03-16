/**
 * RackPatchbay — Dual 19" rack enclosures with integrated patch bay.
 *
 * Two rack chassis side-by-side (Sources left, Destinations right) with a
 * patch cable channel between them. SVG bezier curves connect routed slots.
 *
 * Routing:
 *   1. Click a source slot to select it (violet highlight)
 *   2. Click any destination slot to create a route
 *   3. Click × on a patch cable to remove the route
 *   4. Press Escape to cancel selection
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { api, type Source, type Destination, type Route } from '../api.js'
import AddSourcePanel from './AddSourcePanel.js'
import AddDestPanel from './AddDestPanel.js'

// ── Brand tokens ──────────────────────────────────────────────────────────────

const C = {
  base:       '#141418',
  panel:      '#1E1E2A',
  raised:     '#282838',
  elevated:   '#323244',
  textPrimary:'#EEEEF2',
  textSub:    '#8E8E9F',
  textMuted:  '#555566',
  violet:     '#8B5CF6',
  live:       '#10B981',
  warning:    '#F59E0B',
  error:      '#EF4444',
  // Rack-specific tones
  chassis:    '#0C0C16',   // outer rack body
  rackFace:   '#1A1A28',   // slot faceplate dark
  rackFaceTop:'#222236',   // faceplate gradient top
  rail:       '#111120',   // mounting strip
  screwRim:   '#252538',   // screw hole border
}

const STATUS_COLOR: Record<string, string> = {
  active:      C.live,
  waiting:     C.warning,
  error:       C.error,
  idle:        C.textMuted,
  placeholder: C.raised,
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

const SLOT_H = 48  // 1U height in pixels

interface RouteLine {
  id: string
  x1: number; y1: number
  x2: number; y2: number
  isActive: boolean
  route: Route
}

// ── Rack primitives ───────────────────────────────────────────────────────────

function ScrewHole() {
  return (
    <div style={{
      width: 7, height: 7,
      borderRadius: 2,
      background: C.chassis,
      border: `1px solid ${C.screwRim}`,
      boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.7)',
      flexShrink: 0,
    }} />
  )
}

/** Left or right mounting rail strip for a rack unit slot */
function MountingRail({ side }: { side: 'left' | 'right' }) {
  return (
    <div style={{
      width: 20,
      height: SLOT_H,
      background: C.rail,
      borderLeft:  side === 'right' ? `1px solid ${C.chassis}` : undefined,
      borderRight: side === 'left'  ? `1px solid ${C.chassis}` : undefined,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'space-evenly',
      flexShrink: 0,
    }}>
      <ScrewHole />
      <ScrewHole />
    </div>
  )
}

/** Top chassis cap panel — the rack label row */
function RackHeader({ title, count, color, onAdd }: { title: string; count: number; color: string; onAdd: () => void }) {
  return (
    <div style={{
      display: 'flex',
      height: 40,
      background: C.chassis,
      borderBottom: `2px solid ${C.chassis}`,
    }}>
      {/* Left cap */}
      <div style={{
        width: 20, background: C.rail,
        borderRight: `1px solid ${C.chassis}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
      }}>
        <ScrewHole />
      </div>

      {/* Label faceplate */}
      <div style={{
        flex: 1,
        background: `linear-gradient(to bottom, #1a1a28, #141420)`,
        display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10,
      }}>
        <div style={{ width: 3, height: 16, background: color, borderRadius: 1, flexShrink: 0 }} />
        <span style={{
          fontWeight: 700, fontSize: 11, color: C.textPrimary,
          textTransform: 'uppercase', letterSpacing: 1.5,
        }}>
          {title}
        </span>
        <span style={{
          fontSize: 10, color: C.textMuted,
          background: C.chassis, padding: '1px 6px',
          borderRadius: 8, border: `1px solid ${C.raised}`,
          fontFamily: 'Courier New, Consolas, monospace',
        }}>
          {String(count).padStart(2, '0')}
        </span>
        <button
          onClick={onAdd}
          style={{
            marginLeft: 'auto',
            background: `${color}22`,
            border: `1px solid ${color}55`,
            borderRadius: 3,
            padding: '3px 10px',
            color, fontSize: 11, cursor: 'pointer', fontWeight: 600,
          }}
        >
          + Add
        </button>
      </div>

      {/* Right cap */}
      <div style={{
        width: 20, background: C.rail,
        borderLeft: `1px solid ${C.chassis}`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
      }}>
        <ScrewHole />
      </div>
    </div>
  )
}

function ActionBtn({ onClick, label, color }: { onClick: () => void; label: string; color: string }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{
        background: 'transparent',
        border: `1px solid ${color}`,
        borderRadius: 3, padding: '2px 8px', fontSize: 10,
        color, cursor: 'pointer', lineHeight: 1.4, flexShrink: 0,
        fontWeight: 500,
      }}
    >
      {label}
    </button>
  )
}

// ── Source slot (1U faceplate) ────────────────────────────────────────────────

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
  const statusColor = STATUS_COLOR[src.status] ?? C.textMuted
  const faceColor = selected ? `${C.violet}22` : isPlaceholder ? C.chassis : C.rackFace

  return (
    <div
      ref={divRef}
      style={{
        display: 'flex',
        height: SLOT_H,
        borderBottom: `1px solid ${C.chassis}`,
        cursor: isPlaceholder ? 'default' : 'pointer',
        userSelect: 'none',
      }}
      onClick={onClick}
    >
      {/* Left mounting rail */}
      <MountingRail side="left" />

      {/* Faceplate */}
      <div style={{
        flex: 1,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 10px',
        background: selected
          ? `linear-gradient(to bottom, ${C.violet}28, ${C.violet}14)`
          : isPlaceholder
            ? C.chassis
            : `linear-gradient(to bottom, ${C.rackFaceTop}, ${C.rackFace})`,
        border: selected ? `1px solid ${C.violet}60` : `1px solid transparent`,
        borderTop: 'none', borderBottom: 'none',
        borderLeft: selected ? `1px solid ${C.violet}60` : undefined,
        borderRight: selected ? `1px solid ${C.violet}60` : undefined,
        transition: 'background 0.12s',
        overflow: 'hidden',
      }}>
        {/* Unit number */}
        <span style={{
          fontSize: 9, color: selected ? C.violet : C.textMuted,
          fontFamily: 'Courier New, Consolas, monospace',
          fontVariantNumeric: 'tabular-nums',
          minWidth: 16, textAlign: 'right', flexShrink: 0,
          letterSpacing: 0.5,
        }}>
          {String(slot).padStart(2, '0')}
        </span>

        {/* Status LED */}
        <span style={{
          display: 'inline-block', width: 6, height: 6,
          borderRadius: '50%',
          background: statusColor,
          boxShadow: src.status === 'active' ? `0 0 6px ${statusColor}` : undefined,
          flexShrink: 0,
        }} />

        {/* Type icon */}
        <span style={{ fontSize: 13, flexShrink: 0 }}>{TYPE_ICON[src.source_type] ?? '📡'}</span>

        {/* Name + type */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 600, fontSize: 12, color: C.textPrimary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {src.name}
          </div>
          <div style={{ fontSize: 9, color: C.textSub, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 1 }}>
            {src.source_type.replace(/_/g, ' ')}
            {myRoutes.length > 0 && (
              <span style={{ color: statusColor, marginLeft: 5 }}>
                · {myRoutes.length}▸
              </span>
            )}
          </div>
        </div>

        {/* Controls */}
        {!isPlaceholder && (
          src.status === 'active'
            ? <ActionBtn onClick={() => onStop(src.id)} label="Stop" color={C.textSub} />
            : <ActionBtn onClick={() => onStart(src.id)} label="Start" color={C.violet} />
        )}
        <ActionBtn onClick={() => onDelete(src.id)} label="✕" color={`${C.error}55`} />
      </div>

      {/* Right mounting rail */}
      <MountingRail side="right" />
    </div>
  )
}

// ── Dest slot (1U faceplate) ──────────────────────────────────────────────────

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
  const statusColor = STATUS_COLOR[dest.status] ?? C.textMuted

  return (
    <div
      ref={divRef}
      style={{
        display: 'flex',
        height: SLOT_H,
        borderBottom: `1px solid ${C.chassis}`,
        cursor: isTarget ? 'crosshair' : 'default',
        userSelect: 'none',
      }}
      onClick={onClick}
    >
      {/* Left mounting rail */}
      <MountingRail side="left" />

      {/* Faceplate */}
      <div style={{
        flex: 1,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 10px',
        background: isTarget
          ? `linear-gradient(to bottom, ${C.violet}20, ${C.violet}10)`
          : isPlaceholder
            ? C.chassis
            : `linear-gradient(to bottom, ${C.rackFaceTop}, ${C.rackFace})`,
        border: isTarget ? `1px solid ${C.violet}50` : `1px solid transparent`,
        borderTop: 'none', borderBottom: 'none',
        transition: 'background 0.12s',
        overflow: 'hidden',
      }}>
        {/* Unit number */}
        <span style={{
          fontSize: 9, color: isTarget ? C.violet : C.textMuted,
          fontFamily: 'Courier New, Consolas, monospace',
          fontVariantNumeric: 'tabular-nums',
          minWidth: 16, textAlign: 'right', flexShrink: 0,
          letterSpacing: 0.5,
        }}>
          {String(slot).padStart(2, '0')}
        </span>

        {/* Status LED */}
        <span style={{
          display: 'inline-block', width: 6, height: 6,
          borderRadius: '50%',
          background: statusColor,
          boxShadow: dest.status === 'active' ? `0 0 6px ${statusColor}` : undefined,
          flexShrink: 0,
        }} />

        {/* Type icon */}
        <span style={{ fontSize: 13, flexShrink: 0 }}>{TYPE_ICON[dest.dest_type] ?? '📺'}</span>

        {/* Name + type */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 600, fontSize: 12, color: C.textPrimary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {dest.name}
          </div>
          <div style={{ fontSize: 9, color: C.textSub, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 1 }}>
            {dest.dest_type.replace(/_/g, ' ')}
            {myRoutes.length > 0 && (
              <span style={{ color: statusColor, marginLeft: 5 }}>
                ◂ {myRoutes.length}
              </span>
            )}
          </div>
        </div>

        {/* Controls */}
        {!isPlaceholder && (
          dest.status === 'active'
            ? <ActionBtn onClick={() => onStop(dest.id)} label="Stop" color={C.textSub} />
            : <ActionBtn onClick={() => onStart(dest.id)} label="Start" color={C.violet} />
        )}
        <ActionBtn onClick={() => onDelete(dest.id)} label="✕" color={`${C.error}55`} />
      </div>

      {/* Right mounting rail */}
      <MountingRail side="right" />
    </div>
  )
}

/** Empty rack unit placeholder shown when column is empty */
function EmptySlot({ message }: { message: string }) {
  return (
    <div style={{ display: 'flex', height: SLOT_H, borderBottom: `1px solid ${C.chassis}` }}>
      <MountingRail side="left" />
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: C.chassis,
        borderTop: `1px dashed ${C.raised}22`,
      }}>
        <span style={{ fontSize: 11, color: C.textMuted }}>{message}</span>
      </div>
      <MountingRail side="right" />
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

  useEffect(() => {
    const frame = requestAnimationFrame(() => recalcLines(routes))
    return () => cancelAnimationFrame(frame)
  }, [routes, recalcLines])

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedSourceId(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) return <div style={{ padding: '2rem', color: C.textSub }}>Loading rack...</div>

  const activeSources = sources.filter(s => s.status === 'active').length
  const activeDests = dests.filter(d => d.status === 'active').length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: C.base }}>

      {/* Status bar */}
      <div style={{
        padding: '0 20px', background: C.panel, borderBottom: `1px solid ${C.raised}`,
        display: 'flex', gap: 20, alignItems: 'center', height: 34, flexShrink: 0,
      }}>
        {selectedSourceId ? (
          <span style={{ fontSize: 11, color: C.violet, fontWeight: 600 }}>
            Source selected — click a destination to route ·{' '}
            <span style={{ fontWeight: 400, color: C.textMuted }}>Esc to cancel</span>
          </span>
        ) : (
          <>
            <span style={{ fontSize: 11, color: C.textSub }}>
              <span style={{ color: C.live, fontWeight: 600, fontFamily: 'Courier New, monospace' }}>{activeSources}</span>
              <span style={{ color: C.textMuted }}>/{sources.length}</span> sources active
            </span>
            <span style={{ fontSize: 11, color: C.textSub }}>
              <span style={{ color: C.live, fontWeight: 600, fontFamily: 'Courier New, monospace' }}>{activeDests}</span>
              <span style={{ color: C.textMuted }}>/{dests.length}</span> destinations active
            </span>
            <span style={{ fontSize: 11, color: C.textSub }}>
              <span style={{ color: C.textPrimary, fontWeight: 600, fontFamily: 'Courier New, monospace' }}>{routes.length}</span> routes
            </span>
            <span style={{ fontSize: 10, color: C.textMuted, marginLeft: 'auto' }}>
              Select a source to begin routing
            </span>
          </>
        )}
      </div>

      {/* Dual rack + patch channel */}
      <div
        ref={mainRef}
        style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', gap: 0, background: C.base, padding: '16px 20px', gap: 0 }}
      >
        {/* ── Left rack (Sources) ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Rack chassis */}
          <div style={{
            background: C.chassis,
            border: `2px solid ${C.chassis}`,
            borderRadius: 4,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.03), 0 4px 20px rgba(0,0,0,0.6)`,
            overflow: 'hidden',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
          }}>
            <RackHeader
              title="Sources"
              count={sources.length}
              color={C.violet}
              onAdd={() => setShowAddSource(true)}
            />
            {/* Slots */}
            <div
              ref={leftColRef}
              style={{ flex: 1, overflowY: 'auto' }}
            >
              {sources.length === 0
                ? <EmptySlot message="No sources connected. Add one above." />
                : sources.map((src, i) => (
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
                ))
              }
            </div>
          </div>
        </div>

        {/* ── Patch cable channel ── */}
        <div style={{
          width: 120,
          flexShrink: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          paddingTop: 40, // align with rack slot area (below header)
        }}>
          {/* Channel label */}
          <div style={{
            position: 'absolute',
            top: 10,
            fontSize: 8,
            color: C.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 2,
            userSelect: 'none',
          }}>
            PATCH
          </div>
          {/* Vertical center line */}
          <div style={{
            position: 'absolute', top: 40, bottom: 0, left: '50%',
            width: 1, background: `${C.raised}40`,
            transform: 'translateX(-50%)',
          }} />
        </div>

        {/* ── Right rack (Destinations) ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            background: C.chassis,
            border: `2px solid ${C.chassis}`,
            borderRadius: 4,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.03), 0 4px 20px rgba(0,0,0,0.6)`,
            overflow: 'hidden',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
          }}>
            <RackHeader
              title="Destinations"
              count={dests.length}
              color={`${C.violet}BB`}
              onAdd={() => setShowAddDest(true)}
            />
            <div
              ref={rightColRef}
              style={{ flex: 1, overflowY: 'auto' }}
            >
              {dests.length === 0
                ? <EmptySlot message="No destinations. Add one above." />
                : dests.map((dest, i) => (
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
                ))
              }
            </div>
          </div>
        </div>

        {/* ── SVG patch cables (absolute overlay over full main area) ── */}
        <svg style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
          pointerEvents: 'none', overflow: 'visible',
        }}>
          <defs>
            <filter id="cable-glow">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {routeLines.map(line => {
            const spread = 60
            const path = `M ${line.x1} ${line.y1} C ${line.x1 + spread} ${line.y1}, ${line.x2 - spread} ${line.y2}, ${line.x2} ${line.y2}`
            const color = line.isActive ? C.live : C.raised
            return (
              <path
                key={line.id}
                d={path}
                stroke={color}
                strokeWidth={line.isActive ? 2 : 1.5}
                fill="none"
                strokeDasharray={line.isActive ? undefined : '6 4'}
                opacity={line.isActive ? 1 : 0.5}
                filter={line.isActive ? 'url(#cable-glow)' : undefined}
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
                title="Disconnect"
                style={{
                  position: 'absolute',
                  left: mx, top: my,
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: 'all',
                  background: C.elevated,
                  border: `1px solid ${line.isActive ? `${C.live}55` : C.raised}`,
                  borderRadius: '50%',
                  width: 18, height: 18,
                  fontSize: 10, color: C.textSub,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 0,
                  boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
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
