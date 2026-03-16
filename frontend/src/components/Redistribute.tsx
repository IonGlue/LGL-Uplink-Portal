/**
 * Redistribute — focused view for the re-streaming workflow.
 *
 * Left column: all active input sources (encoders, SRT, test patterns).
 * Right column: RTMP redistribute modules (destinations with dest_type=rtmp).
 *
 * Connecting: click "Connect" on a module → source picker appears → select
 * a source → route is created. Disconnect removes the route.
 */
import { useState, useEffect, useCallback } from 'react'
import { api, type Source, type Destination, type Route } from '../api.js'
import AddRedistributePanel from './AddRedistributePanel.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  youtube: { label: 'YouTube', color: '#ff0000', icon: '▶' },
  twitch:  { label: 'Twitch',  color: '#9147ff', icon: '◈' },
  facebook:{ label: 'Facebook',color: '#1877f2', icon: 'f' },
  custom:  { label: 'RTMP',    color: '#64748b', icon: '⟶' },
}

function detectPlatform(dest: Destination): string {
  const stored = dest.config?._platform as string | undefined
  if (stored && PLATFORM_META[stored]) return stored
  const url = (dest.config?.url as string) ?? ''
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube'
  if (url.includes('twitch.tv')) return 'twitch'
  if (url.includes('facebook.com') || url.includes('fbcdn.net')) return 'facebook'
  return 'custom'
}

function maskKey(dest: Destination): string {
  const explicit = dest.config?._stream_key as string | undefined
  if (explicit) return explicit.slice(0, 4) + '••••••••' + explicit.slice(-4)
  // Try to extract key from URL path last segment
  const url = (dest.config?.url as string) ?? ''
  const parts = url.split('/')
  const key = parts[parts.length - 1]
  if (!key || key.length < 6) return url
  return parts.slice(0, -1).join('/') + '/' + key.slice(0, 3) + '•'.repeat(Math.max(0, key.length - 6)) + key.slice(-3)
}

const STATUS_DOT: Record<string, string> = {
  active:  '#22c55e',
  waiting: '#eab308',
  error:   '#ef4444',
  idle:    '#475569',
}

const SOURCE_TYPE_ICON: Record<string, string> = {
  encoder:      '📡',
  srt_listen:   '🔗',
  srt_pull:     '🔗',
  rtmp_pull:    '📺',
  test_pattern: '🎨',
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

// ── Source card (input) ──────────────────────────────────────────────────────

function SourceCard({ src, connected, selected, onSelect }: {
  src: Source
  connected: boolean    // has at least one redistribute route
  selected: boolean     // currently selected for connecting
  onSelect: () => void
}) {
  const dotColor = STATUS_DOT[src.status] ?? '#475569'
  const icon = SOURCE_TYPE_ICON[src.source_type] ?? '📡'

  return (
    <div
      onClick={onSelect}
      style={{
        padding: '12px 14px',
        borderRadius: 8,
        border: `1.5px solid ${selected ? '#3b82f6' : connected ? '#1e3a5f' : '#1e2130'}`,
        background: selected ? '#0f1d36' : '#1a1e2a',
        cursor: 'pointer',
        transition: 'all 0.15s',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0, display: 'inline-block' }} />
        <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {src.name}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
            {src.source_type.replace('_', ' ')}
            {src.device_id && <span style={{ color: '#2d3348', marginLeft: 6 }}>↔ {src.device_id.slice(0, 14)}</span>}
          </div>
        </div>
        {connected && (
          <span style={{ fontSize: 10, color: '#3b82f6', background: '#0f1d36', border: '1px solid #1e3a5f', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>
            routing
          </span>
        )}
      </div>
      {selected && (
        <div style={{ fontSize: 11, color: '#3b82f6', marginTop: 8, paddingTop: 8, borderTop: '1px solid #1e2130' }}>
          Click a module on the right to connect →
        </div>
      )}
    </div>
  )
}

// ── Redistribute module card (output) ───────────────────────────────────────

function RedistributeCard({ dest, route, sources, selecting, onConnect, onDisconnect, onStart, onStop, onDelete }: {
  dest: Destination
  route: Route | null        // existing route if connected
  sources: Source[]          // all sources (for the picker)
  selecting: boolean         // a source is selected, waiting for click here
  onConnect: () => void      // called when clicking while a source is selected
  onDisconnect: () => void
  onStart: () => void
  onStop: () => void
  onDelete: () => void
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showKeyVisible, setShowKeyVisible] = useState(false)

  const platformId = detectPlatform(dest)
  const meta = PLATFORM_META[platformId]
  const dotColor = STATUS_DOT[dest.status] ?? '#475569'
  const isActive = dest.status === 'active'
  const connectedSource = route ? sources.find(s => s.id === route.source_id) : null

  const displayUrl = showKeyVisible
    ? (dest.config?.url as string ?? '')
    : maskKey(dest)

  return (
    <div
      onClick={selecting ? onConnect : undefined}
      style={{
        padding: '14px 16px',
        borderRadius: 10,
        border: `1.5px solid ${selecting ? '#3b82f6' : isActive ? meta.color + '60' : '#1e2130'}`,
        background: selecting ? '#0f1d36' : '#1a1e2a',
        cursor: selecting ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
        position: 'relative',
      }}
    >
      {/* Platform header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, background: meta.color + '20',
          border: `1px solid ${meta.color}40`, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 13, color: meta.color, fontWeight: 700, flexShrink: 0,
        }}>
          {meta.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {dest.name}
          </div>
          <div style={{ fontSize: 11, color: '#64748b' }}>{meta.label}</div>
        </div>
        {/* Status dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
          <span style={{ fontSize: 11, color: dotColor, textTransform: 'uppercase', letterSpacing: 0.5 }}>{dest.status}</span>
        </div>
      </div>

      {/* Stream URL / key */}
      <div style={{ background: '#0f1117', borderRadius: 6, padding: '7px 10px', marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: '#2d3348', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>
          RTMP target
          <button
            onClick={e => { e.stopPropagation(); setShowKeyVisible(v => !v) }}
            style={{ marginLeft: 8, background: 'none', border: 'none', color: '#475569', fontSize: 10, cursor: 'pointer', padding: 0 }}
          >
            {showKeyVisible ? 'hide' : 'reveal'}
          </button>
        </div>
        <code style={{ fontSize: 11, color: '#64748b', wordBreak: 'break-all', display: 'block' }}>
          {displayUrl}
        </code>
      </div>

      {/* Source connection */}
      <div style={{ marginBottom: 12 }}>
        {connectedSource ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', gap: 6,
              background: '#0f1d36', border: '1px solid #1e3a5f', borderRadius: 6, padding: '6px 10px',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_DOT[connectedSource.status] ?? '#475569', display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: '#93c5fd', fontWeight: 600 }}>{connectedSource.name}</span>
              <span style={{ fontSize: 10, color: '#475569' }}>{connectedSource.source_type.replace('_', ' ')}</span>
            </div>
            <button
              onClick={e => { e.stopPropagation(); onDisconnect() }}
              style={{ background: 'none', border: '1px solid #2d3348', borderRadius: 6, padding: '4px 8px', color: '#64748b', fontSize: 11, cursor: 'pointer' }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              flex: 1, fontSize: 12, color: '#2d3348', fontStyle: 'italic',
              background: '#0f1117', border: '1px dashed #2d3348', borderRadius: 6, padding: '6px 10px',
            }}>
              Not connected — select an input source
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {isActive ? (
          <ActionBtn label="Stop" color="#64748b" onClick={e => { e.stopPropagation(); onStop() }} />
        ) : (
          <ActionBtn
            label="Start"
            color={connectedSource ? meta.color : '#2d3348'}
            onClick={e => { e.stopPropagation(); onStart() }}
            disabled={!connectedSource}
            title={!connectedSource ? 'Connect a source first' : undefined}
          />
        )}

        {showDeleteConfirm ? (
          <>
            <span style={{ fontSize: 11, color: '#f87171', marginLeft: 4 }}>Delete?</span>
            <ActionBtn label="Yes" color="#ef4444" onClick={e => { e.stopPropagation(); onDelete() }} />
            <ActionBtn label="No" color="#64748b" onClick={e => { e.stopPropagation(); setShowDeleteConfirm(false) }} />
          </>
        ) : (
          <ActionBtn label="Delete" color="#475569" onClick={e => { e.stopPropagation(); setShowDeleteConfirm(true) }} />
        )}

        {selecting && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#3b82f6', fontStyle: 'italic' }}>
            ← click to connect
          </span>
        )}
      </div>
    </div>
  )
}

function ActionBtn({ label, color, onClick, disabled, title }: {
  label: string; color: string; onClick: React.MouseEventHandler; disabled?: boolean; title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: 'transparent',
        border: `1px solid ${disabled ? '#1e2130' : color}`,
        borderRadius: 5, padding: '4px 10px',
        fontSize: 11, color: disabled ? '#2d3348' : color,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Redistribute() {
  const [sources, setSources] = useState<Source[]>([])
  const [dests, setDests] = useState<Destination[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, d, r] = await Promise.all([api.getSources(), api.getDests(), api.getRoutes()])
      setSources(s.filter(x => x.source_type !== 'placeholder'))
      setDests(d.filter(x => x.dest_type === 'rtmp'))
      setRoutes(r)
    } catch (e) {
      console.error('failed to load redistribute:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [load])

  // Deselect source on outside click
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setSelectedSourceId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Routes that involve our redistribute modules
  const redistRoutes = routes.filter(r => dests.some(d => d.id === r.dest_id))

  async function handleConnect(sourceId: string, destId: string) {
    // Remove any existing route to this dest first (one source per dest)
    const existing = redistRoutes.find(r => r.dest_id === destId)
    if (existing) await api.deleteRoute(existing.id)
    await api.createRoute(sourceId, destId)
    setSelectedSourceId(null)
    load()
  }

  async function handleDisconnect(routeId: string) {
    await api.deleteRoute(routeId)
    load()
  }

  async function handleStart(destId: string) {
    try { await api.startDest(destId); load() } catch (e) { console.error(e) }
  }

  async function handleStop(destId: string) {
    try { await api.stopDest(destId); load() } catch (e) { console.error(e) }
  }

  async function handleDelete(destId: string) {
    // Remove routes first
    for (const r of redistRoutes.filter(r => r.dest_id === destId)) {
      await api.deleteRoute(r.id)
    }
    await api.deleteDest(destId)
    load()
  }

  const activeCount = dests.filter(d => d.status === 'active').length
  const connectedCount = redistRoutes.length

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading...</div>

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0f1117' }}
      onClick={() => selectedSourceId && setSelectedSourceId(null)}
    >
      {/* Stats bar */}
      <div style={{ padding: '8px 20px', background: '#141722', borderBottom: '1px solid #2d3348', display: 'flex', gap: 20, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          <span style={{ color: '#94a3b8', fontWeight: 600 }}>{sources.length}</span> sources available
        </span>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>{activeCount}</span>/{dests.length} modules active
        </span>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          <span style={{ color: '#94a3b8', fontWeight: 600 }}>{connectedCount}</span> routes
        </span>
        {selectedSourceId && (
          <span style={{ fontSize: 12, color: '#3b82f6', marginLeft: 'auto', fontStyle: 'italic' }}>
            Source selected — click a module to connect, or press Esc to cancel
          </span>
        )}
      </div>

      {/* Two-column layout */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '340px 1fr', gap: 0, overflow: 'hidden' }}>

        {/* Left: Input sources */}
        <div
          style={{ borderRight: '1px solid #1e2130', overflow: 'auto', padding: '20px 16px 20px 20px', display: 'flex', flexDirection: 'column' }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ width: 3, height: 18, background: '#3b82f6', borderRadius: 2 }} />
            <span style={{ fontWeight: 700, fontSize: 12, color: '#e2e8f0', textTransform: 'uppercase', letterSpacing: 1 }}>Input Sources</span>
            <span style={{ fontSize: 11, color: '#475569', background: '#1a1e2a', padding: '1px 7px', borderRadius: 10, border: '1px solid #2d3348' }}>{sources.length}</span>
          </div>

          {sources.length === 0 ? (
            <EmptyState
              title="No sources yet"
              sub={'Add an encoder or SRT source from the Patchbay or Virtual Rack to see it here.'}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sources.map(src => {
                const hasRoute = redistRoutes.some(r => r.source_id === src.id)
                return (
                  <SourceCard
                    key={src.id}
                    src={src}
                    connected={hasRoute}
                    selected={selectedSourceId === src.id}
                    onSelect={() => setSelectedSourceId(selectedSourceId === src.id ? null : src.id)}
                  />
                )
              })}
            </div>
          )}

          <div style={{ marginTop: 16, padding: '10px 12px', background: '#141722', borderRadius: 8, border: '1px solid #1e2130' }}>
            <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.6 }}>
              <strong style={{ color: '#64748b', display: 'block', marginBottom: 4 }}>How to connect</strong>
              1. Click a source to select it<br />
              2. Click a module on the right to route it<br />
              3. Hit Start on the module to begin streaming<br />
              <span style={{ color: '#2d3348' }}>Press Esc to cancel selection</span>
            </div>
          </div>
        </div>

        {/* Right: Redistribute modules */}
        <div style={{ overflow: 'auto', padding: '20px 20px 20px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <div style={{ width: 3, height: 18, background: '#ef4444', borderRadius: 2 }} />
            <span style={{ fontWeight: 700, fontSize: 12, color: '#e2e8f0', textTransform: 'uppercase', letterSpacing: 1 }}>Redistribute Modules</span>
            <span style={{ fontSize: 11, color: '#475569', background: '#1a1e2a', padding: '1px 7px', borderRadius: 10, border: '1px solid #2d3348' }}>{dests.length}</span>
            <button
              onClick={e => { e.stopPropagation(); setShowAddPanel(true) }}
              style={{ marginLeft: 'auto', background: '#ef444420', border: '1px solid #ef444460', borderRadius: 5, padding: '4px 12px', color: '#ef4444', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              + Add module
            </button>
          </div>

          {dests.length === 0 ? (
            <EmptyState
              title="No redistribute modules"
              sub={'Create a module to push your stream to YouTube, Twitch, Facebook, or any RTMP endpoint.'}
              action={{ label: '+ Add Redistribute Module', onClick: () => setShowAddPanel(true) }}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {dests.map(dest => {
                const route = redistRoutes.find(r => r.dest_id === dest.id) ?? null
                return (
                  <RedistributeCard
                    key={dest.id}
                    dest={dest}
                    route={route}
                    sources={sources}
                    selecting={!!selectedSourceId}
                    onConnect={() => selectedSourceId && handleConnect(selectedSourceId, dest.id)}
                    onDisconnect={() => route && handleDisconnect(route.id)}
                    onStart={() => handleStart(dest.id)}
                    onStop={() => handleStop(dest.id)}
                    onDelete={() => handleDelete(dest.id)}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>

      {showAddPanel && (
        <AddRedistributePanel
          onClose={() => setShowAddPanel(false)}
          onAdded={dest => { setDests(d => [...d, dest]); setShowAddPanel(false) }}
        />
      )}
    </div>
  )
}

function EmptyState({ title, sub, action }: { title: string; sub: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div style={{ padding: '40px 20px', textAlign: 'center', color: '#475569' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, maxWidth: 280, margin: '0 auto', lineHeight: 1.6 }}>{sub}</div>
      {action && (
        <button
          onClick={action.onClick}
          style={{ marginTop: 16, background: '#1a1e2a', border: '1px solid #2d3348', borderRadius: 6, padding: '8px 18px', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
