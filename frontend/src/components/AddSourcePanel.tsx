import { useState, useEffect, FormEvent } from 'react'
import { api, type Source, type Device } from '../api.js'

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

const ENROLL_COLOR: Record<string, string> = {
  enrolled: '#22c55e',
  pending: '#eab308',
  rejected: '#ef4444',
}

export default function AddSourcePanel({ onClose, onAdded }: { onClose: () => void; onAdded: (src: Source) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('encoder')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [deviceId, setDeviceId] = useState('')
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const typeInfo = SOURCE_TYPES.find(t => t.value === type)!

  useEffect(() => {
    if (type === 'encoder') {
      api.getDevices()
        .then(d => setDevices(d.filter(dev => dev.enrollment_state === 'enrolled')))
        .catch(() => {})
    }
  }, [type])

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
      const body: Record<string, unknown> = { name, source_type: type, config }
      if (type === 'encoder' && deviceId) body.device_id = deviceId
      const src = await api.createSource(body)
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

          {/* Encoder: device picker */}
          {type === 'encoder' && (
            <div>
              <label style={s.label}>Device (enrolled encoder)</label>
              {devices.length === 0 ? (
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14, padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '1px solid #2d3348' }}>
                  No enrolled devices found. Devices appear here after they connect and are enrolled.
                </div>
              ) : (
                <select style={s.select} value={deviceId} onChange={e => setDeviceId(e.target.value)}>
                  <option value="">— unlinked (any encoder can use this slot) —</option>
                  {devices.map(d => (
                    <option key={d.id} value={d.device_id}>
                      {d.nickname || d.hostname || d.device_id}
                      {d.status === 'online' ? ' ●' : ' ○'}
                    </option>
                  ))}
                </select>
              )}
              {deviceId && (
                <div style={{ fontSize: 11, color: '#64748b', marginTop: -10, marginBottom: 14 }}>
                  Only this encoder will be accepted on this slot.
                </div>
              )}
              {/* Device status legend */}
              {devices.length > 0 && (
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#64748b', marginBottom: 14 }}>
                  {devices.map(d => (
                    <span key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: d.status === 'online' ? '#22c55e' : '#475569', display: 'inline-block' }} />
                      <span style={{ color: '#94a3b8' }}>{d.nickname || d.hostname || d.device_id.slice(0, 12)}</span>
                      <span style={{ color: ENROLL_COLOR[d.enrollment_state] ?? '#64748b' }}>({d.enrollment_state})</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

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
