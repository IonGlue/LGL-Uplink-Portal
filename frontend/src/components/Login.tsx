import { useState, FormEvent } from 'react'
import { api } from '../api.js'

const s: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0f1117' },
  card: { background: '#1e2130', border: '1px solid #2d3348', borderRadius: 12, padding: '2.5rem', width: 360 },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 8, color: '#e2e8f0' },
  sub: { fontSize: 13, color: '#64748b', marginBottom: 28 },
  label: { display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 },
  input: { width: '100%', background: '#0f1117', border: '1px solid #2d3348', borderRadius: 6, padding: '10px 12px', color: '#e2e8f0', fontSize: 14, outline: 'none', marginBottom: 16 },
  btn: { width: '100%', background: '#3b82f6', border: 'none', borderRadius: 6, padding: '10px', color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer' },
  err: { color: '#f87171', fontSize: 13, marginBottom: 16 },
}

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { token } = await api.login(email, password)
      localStorage.setItem('token', token)
      onLogin()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <div style={s.title}>LGL Ingest</div>
        <div style={s.sub}>Stream routing & management</div>
        <form onSubmit={submit}>
          {error && <div style={s.err}>{error}</div>}
          <label style={s.label}>Email</label>
          <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
          <label style={s.label}>Password</label>
          <input style={s.input} type="password" value={password} onChange={e => setPassword(e.target.value)} required />
          <button style={s.btn} type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  )
}
