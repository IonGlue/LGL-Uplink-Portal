/**
 * AddRedistributePanel — slide-in form to create an RTMP redistribute module.
 *
 * Platforms have pre-filled base URLs so operators only need to paste their
 * stream key. The base URL + key are joined and stored as config.url (what
 * the GStreamer rtmpsink pipeline expects). The key is stored separately in
 * config.stream_key so the UI can mask it.
 */
import { useState, FormEvent } from 'react'
import { api, type Destination } from '../api.js'

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', justifyContent: 'flex-end' },
  panel: { background: '#1a1e2a', width: 400, height: '100%', padding: '28px 24px', overflowY: 'auto', borderLeft: '1px solid #2d3348', display: 'flex', flexDirection: 'column', gap: 0 },
  title: { fontSize: 17, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 },
  sub: { fontSize: 12, color: '#64748b', marginBottom: 24 },
  section: { fontSize: 11, color: '#475569', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 4 },
  label: { display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 5 },
  input: { width: '100%', background: '#0f1117', border: '1px solid #2d3348', borderRadius: 6, padding: '8px 10px', color: '#e2e8f0', fontSize: 13, marginBottom: 14, boxSizing: 'border-box' },
  btn: { background: '#1d4ed8', border: 'none', borderRadius: 6, padding: '9px 18px', color: '#fff', fontWeight: 600, cursor: 'pointer', marginRight: 8, fontSize: 13 },
  cancel: { background: 'transparent', border: '1px solid #2d3348', borderRadius: 6, padding: '9px 18px', color: '#94a3b8', cursor: 'pointer', fontSize: 13 },
}

// Known platforms with base ingest URLs and stream key help text
const PLATFORMS = [
  {
    id: 'youtube',
    label: 'YouTube',
    color: '#ff0000',
    baseUrl: 'rtmp://a.rtmp.youtube.com/live2/',
    keyHelp: 'YouTube Studio → Go Live → Stream key',
    keyPlaceholder: 'xxxx-xxxx-xxxx-xxxx-xxxx',
  },
  {
    id: 'twitch',
    label: 'Twitch',
    color: '#9147ff',
    baseUrl: 'rtmp://live.twitch.tv/app/',
    keyHelp: 'Twitch → Settings → Stream → Primary stream key',
    keyPlaceholder: 'live_xxxxxxxxxx',
  },
  {
    id: 'facebook',
    label: 'Facebook',
    color: '#1877f2',
    baseUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    keyHelp: 'Facebook → Live video → Use stream key',
    keyPlaceholder: 'FB-xxxxxxxxxxxx-x-xxxxxxxxxxxxx',
  },
  {
    id: 'custom',
    label: 'Custom RTMP',
    color: '#64748b',
    baseUrl: '',
    keyHelp: 'Enter the full RTMP URL including any stream key',
    keyPlaceholder: '',
  },
]

function PlatformButton({ platform, selected, onClick }: {
  platform: typeof PLATFORMS[0]
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600,
        background: selected ? platform.color + '22' : '#0f1117',
        border: `1.5px solid ${selected ? platform.color : '#2d3348'}`,
        color: selected ? platform.color : '#64748b',
        transition: 'all 0.15s',
      }}
    >
      {platform.label}
    </button>
  )
}

export default function AddRedistributePanel({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: (d: Destination) => void
}) {
  const [platformId, setPlatformId] = useState('youtube')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState(PLATFORMS[0].baseUrl)
  const [streamKey, setStreamKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const platform = PLATFORMS.find(p => p.id === platformId)!

  function selectPlatform(p: typeof PLATFORMS[0]) {
    setPlatformId(p.id)
    setBaseUrl(p.baseUrl)
    // Auto-name if user hasn't typed anything yet
    if (!name || PLATFORMS.some(pl => pl.label === name)) setName(p.label)
  }

  const fullUrl = platformId === 'custom'
    ? baseUrl // custom: user types full URL in baseUrl field, no key field
    : baseUrl + streamKey

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!fullUrl || fullUrl === platform.baseUrl) {
      setError(platformId === 'custom' ? 'RTMP URL is required' : 'Stream key is required')
      return
    }
    setError('')
    setBusy(true)
    try {
      const config: Record<string, unknown> = {
        url: fullUrl,
        // Keep split values for display masking
        _platform: platformId,
        _base_url: baseUrl,
        _stream_key: streamKey,
      }
      const dest = await api.createDest({ name: name || platform.label, dest_type: 'rtmp', config })
      onAdded(dest)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create redistribute module')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.panel} onClick={e => e.stopPropagation()}>
        <div style={s.title}>Add Redistribute Module</div>
        <div style={s.sub}>Push this stream to any RTMP destination — YouTube, Twitch, Facebook, or a custom endpoint.</div>

        <form onSubmit={submit}>
          {/* Platform selector */}
          <div style={s.section}>Platform</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
            {PLATFORMS.map(p => (
              <PlatformButton key={p.id} platform={p} selected={platformId === p.id} onClick={() => selectPlatform(p)} />
            ))}
          </div>

          {/* Name */}
          <label style={s.label}>Module name</label>
          <input
            style={s.input}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={platform.label}
            required
          />

          {/* URL / key fields */}
          {platformId === 'custom' ? (
            <>
              <label style={s.label}>RTMP URL (including stream key)</label>
              <input
                style={s.input}
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="rtmp://your-server.com/live/STREAM_KEY"
                required
              />
            </>
          ) : (
            <>
              <label style={s.label}>Ingest URL</label>
              <input
                style={{ ...s.input, color: '#475569' }}
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
              />

              <label style={s.label} title={platform.keyHelp}>
                Stream key
                <span style={{ color: '#475569', fontWeight: 400, marginLeft: 6 }}>{platform.keyHelp}</span>
              </label>
              <div style={{ position: 'relative', marginBottom: 14 }}>
                <input
                  style={{ ...s.input, marginBottom: 0, paddingRight: 48, fontFamily: showKey ? 'inherit' : 'monospace', letterSpacing: showKey ? 'normal' : 3 }}
                  type={showKey ? 'text' : 'password'}
                  value={streamKey}
                  onChange={e => setStreamKey(e.target.value)}
                  placeholder={platform.keyPlaceholder}
                  autoComplete="off"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowKey(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 11, padding: '2px 4px' }}
                >
                  {showKey ? 'hide' : 'show'}
                </button>
              </div>
            </>
          )}

          {/* Preview */}
          {fullUrl && fullUrl !== platform.baseUrl && (
            <div style={{ background: '#0f1117', border: '1px solid #2d3348', borderRadius: 6, padding: '8px 10px', marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: '#475569', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 1 }}>Full RTMP URL</div>
              <code style={{ fontSize: 11, color: '#64748b', wordBreak: 'break-all' }}>
                {platformId !== 'custom' && streamKey
                  ? baseUrl + streamKey.slice(0, 4) + '••••••••••••' + streamKey.slice(-4)
                  : fullUrl}
              </code>
            </div>
          )}

          {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>}

          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center' }}>
            <button style={s.btn} type="submit" disabled={busy}>{busy ? 'Creating...' : 'Create module'}</button>
            <button style={s.cancel} type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
