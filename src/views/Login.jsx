import { useState } from 'react'
import { signIn } from '../lib/authData.js'
import { supabase } from '../lib/supabaseClient.js'

// Sign-in screen: CLIENT portal login (email → magic link, no slug needed) on
// top, EMPLOYEE email+password (invite-only) below it.
export default function Login({ pending, onSignOut, email: initialEmail }) {
  const [email, setEmail] = useState(initialEmail || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // client login state
  const [clientEmail, setClientEmail] = useState('')
  const [clientBusy, setClientBusy] = useState(false)
  const [clientSent, setClientSent] = useState(false)
  const [clientErr, setClientErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setErr('')
    setBusy(true)
    try {
      await signIn(email, password)
      // AuthGate's onAuthChange listener takes over from here.
    } catch (e2) {
      const msg = (e2 && e2.message) || String(e2)
      setErr(/invalid login/i.test(msg) ? 'Wrong email or password.' : msg)
      setBusy(false)
    }
  }

  async function submitClient(e) {
    e.preventDefault()
    if (clientBusy) return
    setClientErr('')
    setClientBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('portal', {
        body: { action: 'login_email', email: clientEmail },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setClientSent(true)
    } catch (e2) {
      setClientErr((e2 && e2.message) || String(e2))
    }
    setClientBusy(false)
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#15201b', padding: 20, fontSize: 14, color: '#1a2420' }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: '#1f7a4d', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            <div style={{ width: 18, height: 18, border: '3px solid #eafff2', borderRadius: '50%', borderRightColor: 'transparent' }} />
          </div>
          <div style={{ color: '#f3f7f4', fontWeight: 700, fontSize: 20, letterSpacing: '-.01em' }}>Valet Waste</div>
          <div style={{ fontSize: 11, letterSpacing: '.16em', color: '#5f7568', marginTop: 4 }}>CLIENT PORTAL & DISPATCH CRM</div>
        </div>

        {pending ? (
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Account awaiting approval</div>
            <div style={{ fontSize: 13, color: '#7c8a82', lineHeight: 1.5, marginBottom: 18 }}>
              You're signed in, but this account hasn't been granted staff access yet. Ask an admin to enable it.
            </div>
            <button onClick={onSignOut} style={btnGhost}>Sign out</button>
          </div>
        ) : (
          <>
            {/* CLIENT sign-in */}
            <form onSubmit={submitClient} style={{ background: '#fff', borderRadius: 14, padding: 24 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>Client sign in</div>
              <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14 }}>
                We'll email you a secure one-time link to your customer portal — no password needed.
              </div>
              {clientSent ? (
                <div style={{ background: '#e7f1eb', color: '#1f7a4d', borderRadius: 10, padding: '11px 13px', fontSize: 13, lineHeight: 1.5 }}>
                  ✓ Check your email — if <b>{clientEmail}</b> is on file, your login link is on its way (expires in 15 minutes).
                  <div>
                    <button type="button" onClick={() => setClientSent(false)} style={{ background: 'none', border: 'none', color: '#1f7a4d', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: '6px 0 0', textDecoration: 'underline' }}>
                      Use a different email
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label style={lbl}>Email on file with us</label>
                  <input
                    type="email" autoComplete="email" value={clientEmail} required
                    onChange={(e) => setClientEmail(e.target.value)}
                    style={inp} placeholder="you@example.com"
                  />
                  {clientErr && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 10 }}>{clientErr}</div>}
                  <button type="submit" disabled={clientBusy} style={{ ...btnPrimary, opacity: clientBusy ? 0.7 : 1, marginTop: 14 }}>
                    {clientBusy ? 'Sending…' : 'Email me my portal link'}
                  </button>
                </>
              )}
            </form>

            {/* EMPLOYEE sign-in */}
            <form onSubmit={submit} style={{ background: '#fff', borderRadius: 14, padding: 24, marginTop: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>Employee sign in</div>
              <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14 }}>Staff and drivers — invite-only accounts.</div>
              <label style={lbl}>Email</label>
              <input
                type="email" autoComplete="username" value={email}
                onChange={(e) => setEmail(e.target.value)} required
                style={inp} placeholder="you@allsynccrm.com"
              />
              <label style={{ ...lbl, marginTop: 14 }}>Password</label>
              <input
                type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} required
                style={inp} placeholder="••••••••"
              />
              {err && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 12 }}>{err}</div>}
              <button type="submit" disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.7 : 1, marginTop: 18 }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </>
        )}
        <div style={{ textAlign: 'center', fontSize: 11, color: '#5f7568', marginTop: 16 }}>
          Employee accounts are invite-only · clients can also use the portal link we texted or emailed them
        </div>
      </div>
    </div>
  )
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#5d6b63', marginBottom: 6 }
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 10, padding: '11px 13px', fontSize: 16, color: '#1a2420', outline: 'none' }
const btnPrimary = { width: '100%', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 10, padding: '12px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }
const btnGhost = { background: '#f0f3f0', color: '#1a2420', border: '1px solid #dde2dd', borderRadius: 10, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }
