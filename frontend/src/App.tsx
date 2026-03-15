import { useState, useEffect } from 'react'
import { api } from './api.js'
import Login from './components/Login.js'
import Patchbay from './components/Patchbay.js'

export default function App() {
  const [authed, setAuthed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!localStorage.getItem('token')) { setLoading(false); return }
    api.me()
      .then(() => setAuthed(true))
      .catch(() => { localStorage.removeItem('token') })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading...</div>
  if (!authed) return <Login onLogin={() => setAuthed(true)} />
  return <Patchbay />
}
