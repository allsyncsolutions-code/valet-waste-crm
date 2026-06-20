import { useEffect, useState } from 'react'
import App from './App.jsx'
import Login from './views/Login.jsx'
import { getSession, getProfile, isStaff, signOut, onAuthChange } from './lib/authData.js'

// Gates the whole app behind a Supabase session + staff profile.
//  - no session         -> Login (sign-in form)
//  - session, pending   -> Login (awaiting-approval message)
//  - session + staff    -> App
export default function AuthGate() {
  const [state, setState] = useState('loading') // loading | out | pending | in
  const [profile, setProfile] = useState(null)

  async function refresh() {
    const session = await getSession()
    if (!session) { setProfile(null); setState('out'); return }
    const p = await getProfile()
    setProfile(p)
    setState(isStaff(p) ? 'in' : 'pending')
  }

  useEffect(() => {
    refresh()
    // React to sign-in / sign-out / token refresh from anywhere.
    const off = onAuthChange((session) => {
      if (!session) { setProfile(null); setState('out') }
      else refresh()
    })
    return off
  }, [])

  async function handleSignOut() {
    await signOut()
    setProfile(null)
    setState('out')
  }

  if (state === 'loading') {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#15201b', color: '#5f7568', fontSize: 13 }}>
        Loading…
      </div>
    )
  }
  if (state === 'in') return <App user={profile} onSignOut={handleSignOut} />
  return <Login pending={state === 'pending'} email={profile && profile.email} onSignOut={handleSignOut} />
}
