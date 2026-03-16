import { useState, FormEvent } from 'react'
import { api, type Destination } from '../api.js'

const DEST_TYPES = [
  { value: 'rtmp', label: '📺 RTMP Push', fields: ['url'] },
  { value: 'srt_push', label: '📡 SRT Push', fields: ['host', 'port', 'latency_ms'] },
  { value: 'hls', label: '🌐 HLS', fields: ['location', 'playlist_location', 'target_duration'] },
  { value: 'recorder', label: '💾 Recorder', fields: ['path', 'segment_duration_secs', 'max_size_gb'] },
  { value: 'lgl_ingest', label: '🔄 LGL Ingest (re-stream)', fields: ['host', 'port', 'latency_ms'] },
  { value: 'placeholder', label: '👻 Placeholder', fields: [] },
]

const DEFAULTS: Record<string, Record<string, string>> = {
  rtmp: { url: 'rtmp://' },
  srt_push: { host: '', port: '9999', latency_ms: '200' },
  hls: { location: '/var/hls/stream_%05d.ts', playlist_location: '/var/hls/stream.m3u8', target_duration: '2' },
  recorder: { path: '/recordings', segment_duration_secs: '300', max_size_gb: '100' },
  lgl_ingest: { host: '', port: '5000', latency_ms: '200' },
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', justifyContent: 'flex-end' },
  panel: { background: '#1E1E2A', width: 360, height: '100%', padding: '24px', overflowY: 'auto', borderLeft: '1px solid #282838' },
  title: { fontSize: 18, fontWeight: 700, color: '#EEEEF2', marginBottom: 20 },
  label: { display: 'block', fontSize: 12, color: '#8E8E9F', marginBottom: 6 },
  input: { width: '100%', background: '#141418', border: '1px solid #282838', borderRadius: 6, padding: '8px 10px', color: '#EEEEF2', fontSize: 13, marginBottom: 14 },
  select: { width: '100%', background: '#141418', border: '1px solid #282838', borderRadius: 6, padding: '8px 10px', color: '#EEEEF2', fontSize: 13, marginBottom: 14 },
  btn: { background: '#8B5CF6', border: 'none', borderRadius: 6, padding: '9px 18px', color: '#fff', fontWeight: 600, cursor: 'pointer', marginRight: 8 },
  cancel: { background: 'transparent', border: '1px solid #282838', borderRadius: 6, padding: '9px 18px', color: '#8E8E9F', cursor: 'pointer' },
}

export default function AddDestPanel({ onClose, onAdded }: { onClose: () => void; onAdded: (d: Destination) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('rtmp')
  const [fields, setFields] = useState<Record<string, string>>(DEFAULTS['rtmp'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const typeInfo = DEST_TYPES.find(t => t.value === type)!

  function setType2(t: string) {
    setType(t)
    setFields({ ...(DEFAULTS[t] ?? {}) })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const config: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(fields)) {
        config[k] = isNaN(Number(v)) ? v : Number(v)
      }
      const dest = await api.createDest({ name, dest_type: type, config })
      onAdded(dest)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create destination')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.panel} onClick={e => e.stopPropagation()}>
        <div style={s.title}>Add Destination</div>
        <form onSubmit={submit}>
          {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <label style={s.label}>Name</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. YouTube Live" />
          <label style={s.label}>Type</label>
          <select style={s.select} value={type} onChange={e => setType2(e.target.value)}>
            {DEST_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {typeInfo.fields.map(f => (
            <div key={f}>
              <label style={s.label}>{f.replace(/_/g, ' ')}</label>
              <input
                style={s.input}
                value={fields[f] ?? ''}
                onChange={e => setFields(prev => ({ ...prev, [f]: e.target.value }))}
                placeholder={f}
              />
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <button style={s.btn} type="submit" disabled={busy}>{busy ? 'Adding...' : 'Add Destination'}</button>
            <button style={s.cancel} type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
