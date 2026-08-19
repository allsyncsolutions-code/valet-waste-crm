import { useState } from 'react'
import { signIn } from '../lib/authData.js'
import { supabase } from '../lib/supabaseClient.js'

// Sign-in screen: CLIENT portal login (email → magic link, no slug needed) on
// top, EMPLOYEE email+password (invite-only) below it, with a code-based
// "Forgot password?" flow (staff-reset edge function) for employees.
export default function Login({ pending, onSignOut, email: initialEmail }) {
  // Inside the mobile app's customer view (?app=client) the employee form is
  // hidden — the app has its own "Staff sign-in" entry in the native header.
  const clientOnly = new URLSearchParams(window.location.search).get('app') === 'client'
  const [email, setEmail] = useState(initialEmail || '')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // client login state
  const [clientEmail, setClientEmail] = useState('')
  const [clientBusy, setClientBusy] = useState(false)
  const [clientSent, setClientSent] = useState(false)
  const [clientErr, setClientErr] = useState('')

  // forgot-password state (employee)
  const [forgot, setForgot] = useState(false)
  const [fpStep, setFpStep] = useState('email') // 'email' | 'code' | 'done'
  const [fpCode, setFpCode] = useState('')
  const [fpPw, setFpPw] = useState('')
  const [fpPw2, setFpPw2] = useState('')
  const [showFpPw, setShowFpPw] = useState(false)
  const [showFpPw2, setShowFpPw2] = useState(false)
  const [fpBusy, setFpBusy] = useState(false)
  const [fpErr, setFpErr] = useState('')

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

  function openForgot() {
    setForgot(true)
    setFpStep('email')
    setFpCode('')
    setFpPw('')
    setFpPw2('')
    setFpErr('')
  }

  async function fpSendCode(e) {
    e.preventDefault()
    if (fpBusy) return
    setFpErr('')
    setFpBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('staff-reset', {
        body: { action: 'request_code', email },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setFpStep('code')
    } catch (e2) {
      setFpErr((e2 && e2.message) || String(e2))
    }
    setFpBusy(false)
  }

  async function fpReset(e) {
    e.preventDefault()
    if (fpBusy) return
    setFpErr('')
    if (fpPw.length < 8) { setFpErr('Pick a password with at least 8 characters.'); return }
    if (fpPw !== fpPw2) { setFpErr("Those passwords don't match."); return }
    setFpBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('staff-reset', {
        body: { action: 'reset', email, code: fpCode, new_password: fpPw },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setFpStep('done')
      setPassword('')
    } catch (e2) {
      setFpErr((e2 && e2.message) || String(e2))
    }
    setFpBusy(false)
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#15201b', padding: 20, fontSize: 14, color: '#1a2420' }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ width: 64, height: 64, borderRadius: 14, background: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14, overflow: 'hidden' }}>
            <img
              src="https://ozoonpwuyusvksmydkuu.supabase.co/storage/v1/object/public/branding/logo-1783112222279.jpg"
              alt="Valet Waste"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              onError={(e) => { e.target.style.display = 'none' }}
            />
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

            {/* EMPLOYEE sign-in (hidden in the mobile app's customer view) */}
            {!clientOnly && !forgot && (
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
              <PwInput
                autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} required
                placeholder="••••••••"
                show={showPw} onToggle={() => setShowPw((v) => !v)}
              />
              <div style={{ textAlign: 'right', marginTop: 8 }}>
                <button type="button" onClick={openForgot} style={linkBtn}>Forgot password?</button>
              </div>
              {err && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 12 }}>{err}</div>}
              <button type="submit" disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.7 : 1, marginTop: 14 }}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            )}

            {/* EMPLOYEE forgot password */}
            {!clientOnly && forgot && (
            <div style={{ background: '#fff', borderRadius: 14, padding: 24, marginTop: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>Reset your password</div>
              {fpStep === 'email' && (
                <form onSubmit={fpSendCode}>
                  <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14 }}>
                    We'll email a 6-digit code to your staff email address.
                  </div>
                  <label style={lbl}>Work email</label>
                  <input
                    type="email" autoComplete="username" value={email} required
                    onChange={(e) => setEmail(e.target.value)}
                    style={inp} placeholder="you@allsynccrm.com"
                  />
                  {fpErr && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 10 }}>{fpErr}</div>}
                  <button type="submit" disabled={fpBusy} style={{ ...btnPrimary, opacity: fpBusy ? 0.7 : 1, marginTop: 14 }}>
                    {fpBusy ? 'Sending…' : 'Email me a reset code'}
                  </button>
                </form>
              )}
              {fpStep === 'code' && (
                <form onSubmit={fpReset}>
                  <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 14 }}>
                    If <b>{email}</b> is a staff account, a 6-digit code is on its way (expires in 10 minutes). Enter it below with your new password.
                  </div>
                  <label style={lbl}>6-digit code</label>
                  <input
                    inputMode="numeric" pattern="[0-9]*" maxLength={6} value={fpCode} required
                    onChange={(e) => setFpCode(e.target.value.replace(/\D/g, ''))}
                    style={{ ...inp, letterSpacing: '.3em', fontWeight: 700 }} placeholder="••••••"
                  />
                  <label style={{ ...lbl, marginTop: 14 }}>New password</label>
                  <PwInput
                    autoComplete="new-password" value={fpPw} required
                    onChange={(e) => setFpPw(e.target.value)}
                    placeholder="At least 8 characters"
                    show={showFpPw} onToggle={() => setShowFpPw((v) => !v)}
                  />
                  <label style={{ ...lbl, marginTop: 14 }}>New password again</label>
                  <PwInput
                    autoComplete="new-password" value={fpPw2} required
                    onChange={(e) => setFpPw2(e.target.value)}
                    placeholder="••••••••"
                    show={showFpPw2} onToggle={() => setShowFpPw2((v) => !v)}
                  />
                  {fpErr && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 10 }}>{fpErr}</div>}
                  <button type="submit" disabled={fpBusy} style={{ ...btnPrimary, opacity: fpBusy ? 0.7 : 1, marginTop: 14 }}>
                    {fpBusy ? 'Updating…' : 'Set new password'}
                  </button>
                  <div style={{ textAlign: 'center', marginTop: 10 }}>
                    <button type="button" disabled={fpBusy} onClick={fpSendCode} style={linkBtn}>Resend the code</button>
                  </div>
                </form>
              )}
              {fpStep === 'done' && (
                <div style={{ background: '#e7f1eb', color: '#1f7a4d', borderRadius: 10, padding: '11px 13px', fontSize: 13, lineHeight: 1.5, marginTop: 10 }}>
                  ✓ Password updated — sign in with your new password.
                </div>
              )}
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <button type="button" onClick={() => setForgot(false)} style={linkBtn}>‹ Back to sign in</button>
              </div>
            </div>
            )}
          </>
        )}
        <div style={{ textAlign: 'center', fontSize: 11, color: '#5f7568', marginTop: 16 }}>
          {clientOnly
            ? 'You can also use the portal link we texted or emailed you'
            : 'Employee accounts are invite-only · clients can also use the portal link we texted or emailed them'}
        </div>
      </div>
    </div>
  )
}

// Password input with a show/hide eye toggle so users can see what they typed.
function PwInput({ show, onToggle, ...props }) {
  return (
    <div style={{ position: 'relative' }}>
      <input {...props} type={show ? 'text' : 'password'} style={{ ...inp, paddingRight: 44 }} />
      <button
        type="button" onClick={onToggle} tabIndex={-1}
        aria-label={show ? 'Hide password' : 'Show password'}
        title={show ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 42, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7c8a82', padding: 0 }}
      >
        <EyeIcon open={show} />
      </button>
    </div>
  )
}

function EyeIcon({ open }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#5d6b63', marginBottom: 6 }
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 10, padding: '11px 13px', fontSize: 16, color: '#1a2420', outline: 'none' }
const btnPrimary = { width: '100%', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 10, padding: '12px', fontSize: 15, fontWeight: 600, cursor: 'pointer' }
const btnGhost = { background: '#f0f3f0', color: '#1a2420', border: '1px solid #dde2dd', borderRadius: 10, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }
const linkBtn = { background: 'none', border: 'none', color: '#1f7a4d', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: 0, textDecoration: 'underline' }
