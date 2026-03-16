import { useState, useEffect } from 'react'
import { api } from './api.js'
import Login from './components/Login.js'
import RackPatchbay from './components/RackPatchbay.js'
import Redistribute from './components/Redistribute.js'

type View = 'rack' | 'redistribute'

const NAV_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 0,
  padding: '0 20px', height: 44,
  background: '#141722', borderBottom: '1px solid #2d3348',
}

function NavBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
        color: active ? '#e2e8f0' : '#64748b',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        padding: '0 14px',
        height: '100%',
        cursor: 'pointer',
        transition: 'color 0.15s',
      }}
    >
      {label}
    </button>
  )
}

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [localLogin, setLocalLogin] = useState(false)
  const [view, setView] = useState<View>('rack')

  useEffect(() => {
    // Pick up ?token= injected by the portal and persist it
    const params = new URLSearchParams(window.location.search)
    const urlToken = params.get('token')
    if (urlToken) {
      localStorage.setItem('token', urlToken)
      window.history.replaceState({}, '', window.location.pathname)
    }

    async function init() {
      // If we already have a token, try to verify it first
      if (localStorage.getItem('token')) {
        try {
          await api.me()
          setAuthed(true)
          return
        } catch {
          localStorage.removeItem('token')
        }
      }

      // No valid token — check which auth mode is active
      const config = await api.getConfig().catch(() => ({ local_login: true, portal_url: undefined }))
      if (!config.local_login && config.portal_url) {
        // Logto mode: redirect to the tenant portal
        window.location.href = `${config.portal_url}?return_to=${encodeURIComponent(window.location.href)}`
        return
      }
      setLocalLogin(true)
    }

    init().finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading...</div>
  if (!authed && localLogin) return <Login onLogin={() => setAuthed(true)} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117' }}>
      {/* Top nav */}
      <div style={NAV_STYLE}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0', marginRight: 16 }}>LGL Ingest</span>
        <NavBtn label="Rack" active={view === 'rack'} onClick={() => setView('rack')} />
        <NavBtn label="Redistribute" active={view === 'redistribute'} onClick={() => setView('redistribute')} />
      </div>

      {/* View */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {view === 'rack' ? <RackPatchbay /> : <Redistribute />}
      </div>
    </div>
  )
}
