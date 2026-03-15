import { useState, FormEvent } from 'react'
import { api, type Source } from '../api.js'

const SOURCE_TYPES = [
  { value: 'encoder', label: '📡 Encoder (SRTLA)', fields: [] },
  { value: 'srt_listen', label: '🔗 SRT Listen (inbound)', fields: ['port', 'latency_ms'] },
  { value: 'srt_pull', label: '🔗 SRT Pull (outbound)', fields: ['host', 'port', 'latency_ms'] },
  { value: 'rtmp_pull', label: '📺 RTMP Pull', fields: ['url'] },
  { value: 'test_pattern', label: '🎨 Test Pattern', fields: ['pattern', 'width', 'height', 'framerate', 'bitrate_kbps'] },
  { value: 'placeholder', label: '👻 Placeholder', fields: [] },
]

const DEFAULTS: Record<string, Record<string, string>> = {
  srt_listen: { port: '5100', latency_ms: '200' },
  srt_pull: { host: '', port: '9999', latency_ms: '200' },
  rtmp_pull: { url: '' },
  test_pattern: { pattern: 'smpte', width: '1920', height: '1080', framerate: '30', bitrate_kbps: '4000' },
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', justifyContent: 'flex-end' },
  panel: { background: '#1e2130', width: 360, height: '100%', padding: '24px', overflowY: 'auto', borderLeft: '1px solid #2d3348' },
  title: { fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 20 },
  label: { display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 },
  input: { width: '100%', background: '#0f1117', border: '1px solid #2d3348', borderRadius: 6, padding: '8px 10px', color: '#e2e8f0', fontSize: 13, marginBottom: 14 },
  select: { width: '100%', background: '#0f1117', border: '1px solid #2d3348', borderRadius: 6, padding: '8px 10px', color: '#e2e8f0', fontSize: 13, marginBottom: 14 },
  btn: { background: '#3b82f6', border: 'none', borderRadius: 6, padding: '9px 18px', color: '#fff', fontWeight: 600, cursor: 'pointer', marginRight: 8 },
  cancel: { background: 'transparent', border: '1px solid #2d3348', borderRadius: 6, padding: '9px 18px', color: '#94a3b8', cursor: 'pointer' },
}

export default function AddSourcePanel({ onClose, onAdded }: { onClose: () => void; onAdded: (src: Source) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('encoder')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const typeInfo = SOURCE_TYPES.find(t => t.value === type)!

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
      const src = await api.createSource({ name, source_type: type, config })
      onAdded(src)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create source')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.panel} onClick={e => e.stopPropagation()}>
        <div style={s.title}>Add Source</div>
        <form onSubmit={submit}>
          {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <label style={s.label}>Name</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Camera 1" />
          <label style={s.label}>Type</label>
          <select style={s.select} value={type} onChange={e => setType2(e.target.value)}>
            {SOURCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
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
            <button style={s.btn} type="submit" disabled={busy}>{busy ? 'Adding...' : 'Add Source'}</button>
            <button style={s.cancel} type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}
