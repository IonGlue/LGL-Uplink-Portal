import { useState, useEffect } from 'react'
import { api } from './api.js'
import Login from './components/Login.js'
import Patchbay from './components/Patchbay.js'
import VirtualRack from './components/VirtualRack.js'
import Redistribute from './components/Redistribute.js'

type View = 'patchbay' | 'rack' | 'redistribute'

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
  const [view, setView] = useState<View>('patchbay')

  useEffect(() => {
    if (!localStorage.getItem('token')) { setLoading(false); return }
    api.me()
      .then(() => setAuthed(true))
      .catch(() => { localStorage.removeItem('token') })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading...</div>
  if (!authed) return <Login onLogin={() => setAuthed(true)} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117' }}>
      {/* Top nav */}
      <div style={NAV_STYLE}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0', marginRight: 16 }}>LGL Ingest</span>
        <NavBtn label="Patchbay" active={view === 'patchbay'} onClick={() => setView('patchbay')} />
        <NavBtn label="Virtual Rack" active={view === 'rack'} onClick={() => setView('rack')} />
        <NavBtn label="Redistribute" active={view === 'redistribute'} onClick={() => setView('redistribute')} />
      </div>

      {/* View */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {view === 'patchbay' ? <Patchbay /> : view === 'rack' ? <VirtualRack /> : <Redistribute />}
      </div>
    </div>
  )
}
