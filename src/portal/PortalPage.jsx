// Customer portal (Jobber-style client hub) — reached via each client's
// shareable link (…/?portal=<slug>) or the email-only login on the app's
// login screen. Requires an emailed magic link to unlock; the 30-day session
// token lives in localStorage. No staff auth involved.
//
// Also renders inside the CRM's "Client Portal" tab in PREVIEW mode
// (previewCustomerId prop): staff JWT fetches the same payload via the
// portal fn's admin_data action, and all client actions are disabled.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'

const GREEN = '#1f7a4d'
const tokenKey = (slug) => `vw_portal_${slug}`

async function portalApi(body) {
  const { data, error } = await supabase.functions.invoke('portal', { body })
  if (error) {
    // supabase-js wraps non-2xx — surface the function's message when we can
    let msg = error.message || String(error)
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (e) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

const fmtDT = (ts) => { try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return ts } }
const fmtD = (ts) => { try { return new Date(ts + (String(ts).length === 10 ? 'T12:00:00' : '')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return ts } }
const money = (v) => `$${Number(v || 0).toFixed(2)}`

const DOW = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }
const DAY_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Next occurrence (Date) of any of the property's pickup days, from today.
function nextPickupDate(pickupDays) {
  const days = (Array.isArray(pickupDays) ? pickupDays : []).map((d) => DOW[String(d).trim().toLowerCase()]).filter((d) => d !== undefined)
  if (!days.length) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  for (let i = 0; i < 8; i++) {
    const d = new Date(today.getTime() + i * 86400000)
    if (days.includes(d.getDay())) return d
  }
  return null
}
const fmtNext = (d) => {
  if (!d) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000)
  const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  return diff === 0 ? `Today — ${label}` : diff === 1 ? `Tomorrow — ${label}` : label
}

const REQUEST_KINDS = [
  ['extra_pickup', 'Extra trash pickup'],
  ['junk_removal', 'Junk removal'],
  ['lawn_care', 'Lawn care'],
  ['billing', 'Billing question'],
  ['other', 'Something else'],
]
const kindLabel = (k) => (REQUEST_KINDS.find(([id]) => id === k) || [null, 'Request'])[1]

const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, padding: '16px 18px' }
const btnPrimary = { background: GREEN, color: '#fff', border: 'none', borderRadius: 9, padding: '10px 18px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }
const btnGhost = { background: '#fff', color: '#5d6b63', border: '1px solid #dde2dd', borderRadius: 9, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }
const chip = (bg, fg) => ({ fontSize: 11.5, fontWeight: 700, color: fg, background: bg, borderRadius: 7, padding: '3px 9px', letterSpacing: '.02em' })
const inputStyle = { border: '1px solid #d8ddd6', borderRadius: 9, padding: '10px 12px', fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box' }

export default function PortalPage({ slug, code, previewCustomerId, shareToken }) {
  const preview = !!previewCustomerId
  const shared = !!shareToken // homeowner view-only link: no login, no billing
  const [phase, setPhase] = useState('loading') // loading | email | sent | ready
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('home')
  const [notice, setNotice] = useState('')

  const token = !preview && !shared ? localStorage.getItem(tokenKey(slug)) : null

  async function loadData(tok) {
    const d = shared
      ? await portalApi({ action: 'shared_data', share: shareToken })
      : preview
        ? await portalApi({ action: 'admin_data', customer_id: previewCustomerId })
        : await portalApi({ action: 'data', token: tok })
    setData(d)
    setPhase('ready')
  }

  // Copy this client's view-only homeowner link (mints it on first use).
  async function copyShareLink() {
    try {
      const r = await portalApi({ action: 'share_link', token })
      await navigator.clipboard.writeText(r.url)
      setNotice('✓ View-only link copied — share it with your homeowner. They can see pickups and photos, never billing.')
    } catch (e) {
      setNotice(`Couldn't copy the link: ${e.message || e}`)
    }
  }

  useEffect(() => {
    (async () => {
      setErr('')
      setData(null)
      setPhase('loading')
      setTab('home')
      try {
        if (shared || preview) { await loadData(); return }

        const params = new URLSearchParams(window.location.search)
        const setupSession = params.get('setup_session')
        const setupCancelled = params.get('setup') === 'cancelled'

        if (code) {
          // Arrived from the emailed link: swap the one-time code for a session.
          const r = await portalApi({ action: 'redeem', slug, code })
          localStorage.setItem(tokenKey(slug), r.token)
          const url = new URL(window.location.href)
          url.searchParams.delete('code')
          window.history.replaceState({}, '', url.toString())
          await loadData(r.token)
          return
        }

        const saved = localStorage.getItem(tokenKey(slug))
        if (saved) {
          try {
            if (setupSession) {
              // Back from Stripe Checkout — confirm the saved card.
              try {
                const r = await portalApi({ action: 'confirm_setup', token: saved, session_id: setupSession })
                setNotice(`✓ Your ${r.brand ? r.brand.toUpperCase() + ' ' : ''}card ending ${r.last4 || ''} is saved — autopay is on and your 5th pickup week is free.`)
              } catch (e) { setNotice(`Card setup didn't finish: ${e.message || e}`) }
              const url = new URL(window.location.href)
              url.searchParams.delete('setup_session')
              window.history.replaceState({}, '', url.toString())
            }
            if (setupCancelled) {
              setNotice('Card setup was cancelled — no changes made.')
              const url = new URL(window.location.href)
              url.searchParams.delete('setup')
              window.history.replaceState({}, '', url.toString())
            }
            await loadData(saved)
            return
          } catch (e) { localStorage.removeItem(tokenKey(slug)) }
        }
        setPhase('email')
      } catch (e) {
        setErr(e.message || String(e))
        setPhase('email')
      }
    })()
  }, [slug, previewCustomerId])

  async function requestLink(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await portalApi({ action: 'request_link', slug, email })
      setPhase('sent')
    } catch (e2) { setErr(e2.message || String(e2)) }
    setBusy(false)
  }

  const pendingQuotes = useMemo(() => (data?.quotes || []).filter((q) => q.status === 'sent'), [data])
  const excessCount = useMemo(() => (data?.excess || []).length, [data])
  const nextPickup = useMemo(() => {
    let best = null
    for (const p of data?.properties || []) {
      const d = nextPickupDate(p.pickup_days)
      if (d && (!best || d < best.date)) best = { date: d, property: p }
    }
    return best
  }, [data])

  const shell = (inner) => (
    <div style={{ minHeight: preview ? 'auto' : '100vh', background: '#f2f5f1', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#1a2420', borderRadius: preview ? 14 : 0 }}>
      <div style={{ maxWidth: 780, margin: '0 auto', padding: '20px 14px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          {data?.company?.logo_url ? (
            <img src={data.company.logo_url} alt="logo" style={{ width: 38, height: 38, borderRadius: 9, objectFit: 'cover', background: '#fff' }} />
          ) : (
            <div style={{ width: 38, height: 38, borderRadius: 9, background: GREEN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 17 }}>
              {(data?.company?.name || 'V')[0]}
            </div>
          )}
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{data?.company?.name || 'Customer Portal'}</div>
            <div style={{ fontSize: 12, color: '#7c8a82' }}>{shared ? 'Service updates — view only' : `Client hub${preview ? ' — ADMIN PREVIEW' : ''}`}</div>
          </div>
        </div>
        {inner}
      </div>
    </div>
  )

  if (phase === 'loading') return shell(<div style={{ ...card, textAlign: 'center', color: '#9aa69e' }}>Loading…</div>)

  if (phase === 'email' || phase === 'sent') {
    return shell(
      <div style={{ ...card, maxWidth: 460, margin: '40px auto' }}>
        {phase === 'sent' ? (
          <>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Check your email</div>
            <div style={{ fontSize: 13.5, color: '#5d6b63', lineHeight: 1.5 }}>
              If <b>{email}</b> matches this account, a one-time login link is on its way. It expires in 15 minutes.
            </div>
            <button onClick={() => setPhase('email')} style={{ marginTop: 14, background: 'none', border: 'none', color: GREEN, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 }}>Use a different email</button>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Sign in to your portal</div>
            <div style={{ fontSize: 13.5, color: '#5d6b63', marginBottom: 14 }}>Enter the email on file for your account and we'll send you a secure login link.</div>
            {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 9, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>{err}</div>}
            <form onSubmit={requestLink} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
                style={{ ...inputStyle, padding: '11px 13px' }}
              />
              <button type="submit" disabled={busy} style={{ ...btnPrimary, padding: '11px 0' }}>
                {busy ? 'Sending…' : 'Email me a login link'}
              </button>
            </form>
          </>
        )}
      </div>,
    )
  }

  // ---- signed-in portal --------------------------------------------------------
  // Homeowner share links only see service info — no billing, quotes, requests.
  const TABS = shared
    ? [['home', 'Home'], ['pickups', 'Pickups'], ['photos', 'Photos']]
    : [
        ['home', 'Home'],
        ['pickups', 'Pickups'],
        ['photos', 'Photos'],
        ['quotes', pendingQuotes.length ? `Quotes (${pendingQuotes.length})` : 'Quotes'],
        ['invoices', 'Invoices'],
        ['payments', 'Payments'],
        ['request', 'Request service'],
      ]

  return shell(
    <>
      {notice && (
        <div style={{ background: notice.startsWith('✓') ? '#e7f1eb' : '#faf3e2', color: notice.startsWith('✓') ? GREEN : '#8a6414', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 12, display: 'flex', gap: 10 }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <span onClick={() => setNotice('')} style={{ cursor: 'pointer', fontWeight: 700 }}>✕</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{ background: tab === v ? GREEN : '#fff', color: tab === v ? '#fff' : '#5d6b63', border: `1px solid ${tab === v ? GREEN : '#dde2dd'}`, borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{l}</button>
        ))}
      </div>

      {tab === 'home' && (
        <HomeTab
          data={data} nextPickup={nextPickup} pendingQuotes={pendingQuotes} excessCount={excessCount}
          go={setTab} shared={shared} onShare={!shared && !preview ? copyShareLink : null}
        />
      )}
      {tab === 'pickups' && <PickupsTab data={data} />}
      {tab === 'photos' && <PhotosTab data={data} />}
      {tab === 'quotes' && <QuotesTab data={data} token={token} preview={preview} onChanged={() => loadData(token)} />}
      {tab === 'invoices' && <InvoicesTab data={data} />}
      {tab === 'payments' && <PaymentsTab data={data} token={token} preview={preview} onChanged={() => loadData(token)} setNotice={setNotice} />}
      {tab === 'request' && <RequestTab data={data} token={token} preview={preview} onChanged={() => loadData(token)} />}

      {!preview && !shared && (
        <div style={{ textAlign: 'center', marginTop: 26 }}>
          <button
            onClick={() => { localStorage.removeItem(tokenKey(slug)); setData(null); setPhase('email') }}
            style={{ background: 'none', border: 'none', color: '#9aa69e', fontSize: 12.5, cursor: 'pointer' }}
          >Sign out</button>
        </div>
      )}
    </>,
  )
}

// ---- Home ---------------------------------------------------------------------
function HomeTab({ data, nextPickup, pendingQuotes, excessCount, go, shared, onShare }) {
  const payment = data.payment || {}
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* hero: next pickup */}
      <div style={{ background: 'linear-gradient(150deg,#1f7a4d,#155e3a)', borderRadius: 15, padding: '18px 20px', color: '#fff' }}>
        <div style={{ fontSize: 11, color: '#bfe6d0', letterSpacing: '.08em' }}>NEXT PICKUP</div>
        {nextPickup ? (
          <>
            <div style={{ fontSize: 19, fontWeight: 800, marginTop: 4 }}>{fmtNext(nextPickup.date)}</div>
            <div style={{ fontSize: 12.5, color: '#cfe6d8', marginTop: 3 }}>
              {nextPickup.property.address}
              {(data.properties || []).length > 1 ? ` · ${(data.properties || []).length} service addresses` : ''}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>No recurring pickup day on file — contact us to set one up.</div>
        )}
        <div style={{ fontSize: 13, fontWeight: 700, marginTop: 12, display: 'inline-block', background: 'rgba(255,255,255,.14)', borderRadius: 8, padding: '6px 12px' }}>
          Hi, {data.customer.name}
        </div>
      </div>

      {/* balance + card status (never shown on homeowner share links) */}
      {!shared && (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ ...card, cursor: 'pointer' }} onClick={() => go('invoices')}>
          <div style={{ fontSize: 11.5, color: '#7c8a82' }}>Balance due</div>
          <div style={{ fontSize: 21, fontWeight: 800, marginTop: 4, color: data.balance_due > 0 ? '#1a2420' : GREEN }}>{money(data.balance_due)}</div>
          <div style={{ fontSize: 11.5, color: GREEN, fontWeight: 600, marginTop: 4 }}>{data.balance_due > 0 ? 'View & pay invoices ›' : 'All paid up ✓'}</div>
        </div>
        <div style={{ ...card, cursor: 'pointer' }} onClick={() => go('payments')}>
          <div style={{ fontSize: 11.5, color: '#7c8a82' }}>Payment method</div>
          {payment.saved ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6 }}>{(payment.brand || 'card').toUpperCase()} ••{payment.last4}</div>
              <div style={{ fontSize: 11.5, color: GREEN, fontWeight: 600, marginTop: 4 }}>Autopay on · 5th week free ✓</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>None saved</div>
              <div style={{ fontSize: 11.5, color: '#8a6414', fontWeight: 600, marginTop: 4 }}>Save a card — get your 5th week free ›</div>
            </>
          )}
        </div>
      </div>
      )}

      {pendingQuotes.length > 0 && (
        <div onClick={() => go('quotes')} style={{ ...card, background: '#faf3e2', border: '1px solid #ecd9a8', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 17 }}>📋</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: '#8a6414' }}>{pendingQuotes.length} quote{pendingQuotes.length > 1 ? 's' : ''} awaiting your approval</div>
            <div style={{ fontSize: 12, color: '#a3873f' }}>Review and approve or decline — takes a few seconds.</div>
          </div>
          <span style={{ color: '#8a6414', fontWeight: 700 }}>›</span>
        </div>
      )}

      {excessCount > 0 && (
        <div onClick={() => go('pickups')} style={{ ...card, background: '#faf3e2', border: '1px solid #ecd9a8', cursor: 'pointer', fontSize: 13, color: '#8a6414' }}>
          ⚠ {excessCount} recent {excessCount === 1 ? 'pickup was' : 'pickups were'} flagged as over the usual volume — see Pickups for photos.
        </div>
      )}

      {/* service addresses */}
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Your service {data.properties.length === 1 ? 'address' : 'addresses'}</div>
        {!data.properties.length && <div style={{ fontSize: 13, color: '#9aa69e' }}>No service addresses on file yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.properties.slice(0, 8).map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f7f9f7', borderRadius: 9 }}>
              <span style={{ color: GREEN, fontSize: 14 }}>⌂</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address}</div>
                {p.service && <div style={{ fontSize: 11, color: '#7c8a82' }}>{p.service}</div>}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(p.pickup_days || []).map((d, j) => (
                  <span key={j} style={chip('#e7f1eb', GREEN)}>{String(d).slice(0, 3).toUpperCase()}</span>
                ))}
              </div>
            </div>
          ))}
          {data.properties.length > 8 && <div style={{ fontSize: 12, color: '#9aa69e' }}>+{data.properties.length - 8} more</div>}
        </div>
      </div>

      {/* recent pickups */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Recent pickups</div>
          <button onClick={() => go('pickups')} style={{ background: 'none', border: 'none', color: GREEN, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>See all ›</button>
        </div>
        {!data.pickups.length && <div style={{ fontSize: 13, color: '#9aa69e' }}>No service visits in the last 90 days.</div>}
        {data.pickups.slice(0, 3).map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: i ? '1px solid #f0f2ef' : 'none' }}>
            <span style={{ color: GREEN }}>✓</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{fmtD(p.date)}</div>
              <div style={{ fontSize: 11.5, color: '#9aa69e', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.address}</div>
            </div>
            {p.photos.length > 0 && <span style={{ fontSize: 11.5, color: '#7c8a82' }}>📷 {p.photos.length}</span>}
          </div>
        ))}
      </div>

      {!shared && <button onClick={() => go('request')} style={{ ...btnPrimary, padding: '13px 0', fontSize: 14.5, borderRadius: 12 }}>+ Request service</button>}

      {/* property managers: view-only link for their homeowners */}
      {onShare && (
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>Managing this for a homeowner?</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginTop: 2 }}>Share a view-only link — they see pickups and photos, never your billing.</div>
          </div>
          <button onClick={onShare} style={{ ...btnGhost, flex: 'none' }}>Copy view-only link</button>
        </div>
      )}
    </div>
  )
}

// ---- Pickups -------------------------------------------------------------------
function PickupsTab({ data }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!data.pickups.length && <div style={{ ...card, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>No service visits in the last 90 days.</div>}
      {data.pickups.map((p, i) => (
        <div key={i} style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{fmtD(p.date)}</span>
            <span style={{ fontSize: 12.5, color: '#7c8a82' }}>{p.address}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: GREEN, fontWeight: 600 }}>
              {p.checked_out ? `Serviced ${fmtDT(p.checked_in)} – ${fmtDT(p.checked_out)}` : `Arrived ${fmtDT(p.checked_in)}`}
            </span>
          </div>
          {p.excess && (
            <div style={{ marginTop: 8, background: '#faf3e2', color: '#8a6414', borderRadius: 9, padding: '8px 11px', fontSize: 12.5 }}>
              ⚠ Over usual volume{p.excess.note ? ` — ${p.excess.note}` : ''}
              {p.excess.amount != null
                ? ` · additional charge ${money(p.excess.amount)} (added to your invoice)`
                : p.excess.status !== 'dismissed' ? ' · under review' : ''}
            </div>
          )}
          {p.photos.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {p.photos.map((ph, j) => (
                <a key={j} href={ph.url} target="_blank" rel="noreferrer">
                  <img src={ph.url} alt="pickup" style={{ width: 92, height: 92, objectFit: 'cover', borderRadius: 9, border: '1px solid #e6eae6' }} />
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ---- Photos --------------------------------------------------------------------
function PhotosTab({ data }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!data.property_photos.length && <div style={{ ...card, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>No property photos yet.</div>}
      {data.property_photos.map((p, i) => (
        <div key={i} style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: p.url || p.note ? 8 : 0 }}>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>{fmtD(p.date)}</span>
            <span style={{ fontSize: 12.5, color: '#7c8a82' }}>{p.address}</span>
          </div>
          {p.note && <div style={{ fontSize: 13, color: '#5d6b63', marginBottom: p.url ? 8 : 0 }}>{p.note}</div>}
          {p.url && (
            <a href={p.url} target="_blank" rel="noreferrer">
              <img src={p.url} alt="property" style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 10, border: '1px solid #e6eae6' }} />
            </a>
          )}
        </div>
      ))}
    </div>
  )
}

// ---- Quotes --------------------------------------------------------------------
function QuotesTab({ data, token, preview, onChanged }) {
  const [busyId, setBusyId] = useState(null)
  const [noteFor, setNoteFor] = useState(null) // quote id with the note box open
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  async function respond(q, response) {
    if (preview) return
    setBusyId(q.id)
    setErr('')
    try {
      await portalApi({ action: 'quote_respond', token, quote_id: q.id, response, note: noteFor === q.id ? note : '' })
      setNoteFor(null); setNote('')
      await onChanged()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyId(null)
  }

  const statusChip = (s) =>
    s === 'approved' ? <span style={chip('#e7f1eb', GREEN)}>APPROVED</span>
      : s === 'declined' ? <span style={chip('#fbeae6', '#c0492f')}>DECLINED</span>
        : <span style={chip('#faf3e2', '#8a6414')}>AWAITING APPROVAL</span>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 9, padding: '9px 12px', fontSize: 13 }}>{err}</div>}
      {!data.quotes.length && <div style={{ ...card, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>No quotes yet. When we send you a quote it'll show up here for approval.</div>}
      {data.quotes.map((q) => (
        <div key={q.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontSize: 14.5 }}>{q.number}</span>
            {q.title && <span style={{ fontSize: 13.5, color: '#5d6b63' }}>{q.title}</span>}
            <span style={{ flex: 1 }} />
            {statusChip(q.status)}
          </div>
          <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 3 }}>
            Sent {fmtD(q.sent_at || q.created_at)}{q.responded_at ? ` · responded ${fmtD(q.responded_at)}` : ''}
          </div>
          {(q.line_items || []).length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px solid #f0f2ef' }}>
              {q.line_items.map((li, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid #f0f2ef', fontSize: 13 }}>
                  <span style={{ flex: 1 }}>{li.description}</span>
                  {Number(li.quantity) > 1 && <span style={{ color: '#9aa69e' }}>×{li.quantity}</span>}
                  <span style={{ fontWeight: 600 }}>{money(li.amount ?? (Number(li.quantity || 1) * Number(li.unit_price || 0)))}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            {q.notes && <span style={{ fontSize: 12.5, color: '#7c8a82', flex: 1 }}>{q.notes}</span>}
            <span style={{ flex: 1 }} />
            <span style={{ fontWeight: 800, fontSize: 16 }}>{money(q.total)}</span>
          </div>
          {q.status === 'sent' && (
            <>
              {noteFor === q.id && (
                <textarea
                  value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder="Optional note back to us…"
                  style={{ ...inputStyle, marginTop: 10, resize: 'vertical', fontFamily: 'inherit' }}
                />
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button
                  disabled={busyId === q.id || preview}
                  title={preview ? 'Disabled in admin preview' : undefined}
                  onClick={() => respond(q, 'approved')}
                  style={{ ...btnPrimary, opacity: preview ? 0.55 : 1 }}
                >{busyId === q.id ? 'Working…' : '✓ Approve'}</button>
                <button
                  disabled={busyId === q.id || preview}
                  title={preview ? 'Disabled in admin preview' : undefined}
                  onClick={() => respond(q, 'declined')}
                  style={{ ...btnGhost, color: '#c0492f', borderColor: '#eccfc7', opacity: preview ? 0.55 : 1 }}
                >Decline</button>
                {noteFor !== q.id && (
                  <button onClick={() => setNoteFor(q.id)} style={{ background: 'none', border: 'none', color: '#7c8a82', fontSize: 12.5, cursor: 'pointer' }}>+ add a note</button>
                )}
              </div>
            </>
          )}
          {q.response_note && <div style={{ marginTop: 8, fontSize: 12.5, color: '#7c8a82' }}>Your note: “{q.response_note}”</div>}
        </div>
      ))}
    </div>
  )
}

// ---- Invoices ------------------------------------------------------------------
function InvoicesTab({ data }) {
  const payment = data.payment || {}
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {payment.saved && (
        <div style={{ background: '#e7f1eb', color: GREEN, borderRadius: 10, padding: '9px 13px', fontSize: 12.5, fontWeight: 600 }}>
          Autopay is on — open invoices are charged to your {(payment.brand || 'saved').toUpperCase()} ••{payment.last4} at the start of each month.
        </div>
      )}
      {!data.invoices.length && <div style={{ ...card, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>No invoices yet.</div>}
      {data.invoices.map((inv, i) => (
        <div key={i} style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{inv.number}</div>
            <div style={{ fontSize: 12, color: '#7c8a82' }}>{inv.due_date ? `Due ${fmtD(inv.due_date)}` : fmtD(inv.issue_date)}</div>
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ fontWeight: 800, fontSize: 15 }}>{money(inv.total)}</div>
          {inv.status === 'paid' ? (
            <span style={chip('#e7f1eb', GREEN)}>PAID</span>
          ) : inv.stripe_payment_url ? (
            <a href={inv.stripe_payment_url} target="_blank" rel="noreferrer" style={{ ...btnPrimary, padding: '8px 16px', textDecoration: 'none' }}>Pay now</a>
          ) : (
            <span style={chip('#faf3e2', '#8a6414')}>OPEN</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ---- Payments (saved card + 5th-week-free) ---------------------------------------
function PaymentsTab({ data, token, preview, onChanged, setNotice }) {
  const payment = data.payment || {}
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function startSetup() {
    if (preview) return
    setBusy(true)
    setErr('')
    try {
      const r = await portalApi({ action: 'setup_session', token, origin: window.location.origin, consent })
      window.location.href = r.url
    } catch (e) { setErr(e.message || String(e)); setBusy(false) }
  }

  async function removeCard() {
    if (preview) return
    if (!window.confirm('Remove your saved card and turn off autopay? Months with 5 pickup weeks will bill all 5 again.')) return
    setBusy(true)
    setErr('')
    try {
      await portalApi({ action: 'remove_card', token })
      setNotice('Your saved card was removed and autopay is off.')
      await onChanged()
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 9, padding: '9px 12px', fontSize: 13 }}>{err}</div>}

      {!payment.saved ? (
        <>
          {/* 5th-week-free banner */}
          <div style={{ background: 'linear-gradient(150deg,#1f7a4d,#155e3a)', borderRadius: 15, padding: '18px 20px', color: '#fff' }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>🎉 Want your 5th week free?</div>
            <div style={{ fontSize: 13.5, color: '#cfe6d8', marginTop: 6, lineHeight: 1.55 }}>
              Save a payment method and in any month with 5 pickup weeks, the 5th one's on us —
              you only ever pay for 4. Your card is charged automatically at the start of each
              month for the previous month's invoices, so there's nothing to remember.
            </div>
          </div>

          <div style={card}>
            <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 10 }}>Save a payment method</div>
            {!payment.available && (
              <div style={{ background: '#faf3e2', color: '#8a6414', borderRadius: 9, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>
                Online card setup isn't available yet — please contact us to set up autopay.
              </div>
            )}
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13.5, color: '#3c4a42', lineHeight: 1.5, cursor: 'pointer' }}>
              <input
                type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
                style={{ marginTop: 3, width: 16, height: 16, accentColor: GREEN }}
              />
              <span>
                I'm OK with my saved card being <b>charged automatically at the start of each month</b> for
                my open invoices. I can remove my card any time to turn this off.
              </span>
            </label>
            <button
              disabled={!consent || busy || preview || !payment.available}
              title={preview ? 'Disabled in admin preview' : !consent ? 'Check the box above first' : undefined}
              onClick={startSetup}
              style={{ ...btnPrimary, marginTop: 14, padding: '12px 22px', opacity: (!consent || preview || !payment.available) ? 0.55 : 1 }}
            >{busy ? 'Opening secure checkout…' : '🔒 Save payment method'}</button>
            <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 10 }}>
              Card details are entered on Stripe's secure page — we never see or store your card number.
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 46, height: 32, borderRadius: 6, background: '#15201b', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em' }}>
                {(payment.brand || 'CARD').slice(0, 6).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>•••• •••• •••• {payment.last4}</div>
                <div style={{ fontSize: 12, color: GREEN, fontWeight: 600, marginTop: 2 }}>Autopay on — charged at the start of each month ✓</div>
              </div>
              <button
                disabled={busy || preview}
                title={preview ? 'Disabled in admin preview' : undefined}
                onClick={removeCard}
                style={{ ...btnGhost, color: '#c0492f', borderColor: '#eccfc7', opacity: preview ? 0.55 : 1 }}
              >Remove</button>
            </div>
          </div>
          <div style={{ background: '#e7f1eb', color: GREEN, borderRadius: 10, padding: '11px 14px', fontSize: 13, fontWeight: 600 }}>
            🎉 5th-week-free is active — months with 5 pickup weeks only bill 4.
          </div>
        </>
      )}
    </div>
  )
}

// ---- Request service --------------------------------------------------------------
function RequestTab({ data, token, preview, onChanged }) {
  const [kind, setKind] = useState('extra_pickup')
  const [selected, setSelected] = useState([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')

  function toggleProp(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function submit(e) {
    e.preventDefault()
    if (preview) return
    setBusy(true)
    setErr('')
    try {
      await portalApi({ action: 'request_service', token, kind, property_ids: selected, message })
      setDone(true)
      setMessage('')
      setSelected([])
      await onChanged()
    } catch (e2) { setErr(e2.message || String(e2)) }
    setBusy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {done ? (
        <div style={{ ...card, textAlign: 'center' }}>
          <div style={{ fontSize: 28 }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginTop: 6 }}>Request sent!</div>
          <div style={{ fontSize: 13, color: '#7c8a82', marginTop: 4 }}>Our team just got a text about it and will follow up shortly.</div>
          <button onClick={() => setDone(false)} style={{ ...btnGhost, marginTop: 14 }}>Send another request</button>
        </div>
      ) : (
        <form onSubmit={submit} style={card}>
          <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 12 }}>What do you need?</div>
          {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 9, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
            {REQUEST_KINDS.map(([id, label]) => (
              <button type="button" key={id} onClick={() => setKind(id)} style={{ background: kind === id ? GREEN : '#fff', color: kind === id ? '#fff' : '#5d6b63', border: `1px solid ${kind === id ? GREEN : '#dde2dd'}`, borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>{label}</button>
            ))}
          </div>

          {data.properties.length > 0 && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#5d6b63', marginBottom: 8 }}>Which address{data.properties.length > 1 ? 'es' : ''}? <span style={{ color: '#9aa69e', fontWeight: 400 }}>(optional)</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, maxHeight: 180, overflowY: 'auto' }}>
                {data.properties.map((p) => (
                  <label key={p.id} style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13, cursor: 'pointer', padding: '6px 9px', background: selected.includes(p.id) ? '#e7f1eb' : '#f7f9f7', borderRadius: 8 }}>
                    <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggleProp(p.id)} style={{ accentColor: GREEN }} />
                    {p.address}
                  </label>
                ))}
              </div>
            </>
          )}

          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#5d6b63', marginBottom: 8 }}>Tell us more</div>
          <textarea
            value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
            placeholder={kind === 'extra_pickup' ? 'e.g. "Extra bags out back after the weekend event — can you swing by tomorrow?"' : 'Describe what you need…'}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
          <button
            type="submit" disabled={busy || preview}
            title={preview ? 'Disabled in admin preview' : undefined}
            style={{ ...btnPrimary, marginTop: 14, padding: '12px 22px', opacity: preview ? 0.55 : 1 }}
          >{busy ? 'Sending…' : 'Send request'}</button>
        </form>
      )}

      {(data.requests || []).length > 0 && (
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>Recent requests</div>
          {data.requests.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid #f0f2ef', fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>{kindLabel(r.kind)}</span>
              <span style={{ color: '#9aa69e', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.message || ''}</span>
              <span style={{ color: '#9aa69e' }}>{fmtD(r.created_at)}</span>
              <span style={r.status === 'done' ? chip('#e7f1eb', GREEN) : chip('#f0f2ef', '#7c8a82')}>{r.status.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
