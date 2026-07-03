// Public customer portal — reached via each client's shareable link
// (…/?portal=<slug>). Requires an emailed magic link to unlock; the 30-day
// session token lives in localStorage. No staff auth involved.
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
const fmtD = (ts) => { try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return ts } }
const money = (v) => `$${Number(v || 0).toFixed(2)}`

export default function PortalPage({ slug, code }) {
  const [phase, setPhase] = useState('loading') // loading | email | sent | ready
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('pickups')

  async function loadData(token) {
    const d = await portalApi({ action: 'data', token })
    setData(d)
    setPhase('ready')
  }

  useEffect(() => {
    (async () => {
      setErr('')
      try {
        if (code) {
          // Arrived from the emailed link: swap the one-time code for a session.
          const r = await portalApi({ action: 'redeem', slug, code })
          localStorage.setItem(tokenKey(slug), r.token)
          // strip the code from the URL so refreshes don't retry a used code
          const url = new URL(window.location.href)
          url.searchParams.delete('code')
          window.history.replaceState({}, '', url.toString())
          await loadData(r.token)
          return
        }
        const saved = localStorage.getItem(tokenKey(slug))
        if (saved) {
          try { await loadData(saved); return } catch (e) { localStorage.removeItem(tokenKey(slug)) }
        }
        setPhase('email')
      } catch (e) {
        setErr(e.message || String(e))
        setPhase('email')
      }
    })()
  }, [slug])

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

  const excessCount = useMemo(() => (data?.excess || []).length, [data])

  const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, padding: '16px 18px' }
  const shell = (inner) => (
    <div style={{ minHeight: '100vh', background: '#f2f5f1', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#1a2420' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '20px 14px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          {data?.company?.logo_url ? (
            <img src={data.company.logo_url} alt="logo" style={{ width: 38, height: 38, borderRadius: 9, objectFit: 'cover', background: '#fff' }} />
          ) : (
            <div style={{ width: 38, height: 38, borderRadius: 9, background: GREEN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 17 }}>
              {(data?.company?.name || 'V')[0]}
            </div>
          )}
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{data?.company?.name || 'Customer Portal'}</div>
            <div style={{ fontSize: 12, color: '#7c8a82' }}>Customer portal</div>
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
                style={{ border: '1px solid #d8ddd6', borderRadius: 9, padding: '11px 13px', fontSize: 14, outline: 'none' }}
              />
              <button type="submit" disabled={busy} style={{ background: GREEN, color: '#fff', border: 'none', borderRadius: 9, padding: '11px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                {busy ? 'Sending…' : 'Email me a login link'}
              </button>
            </form>
          </>
        )}
      </div>,
    )
  }

  // ---- signed-in portal ----
  const TABS = [
    ['pickups', 'Pickups'],
    ['photos', 'Photos'],
    ['invoices', 'Invoices'],
  ]

  return shell(
    <>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>{data.customer.name}</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3 }}>
          {data.properties.length} service {data.properties.length === 1 ? 'address' : 'addresses'}
          {data.properties.length ? ` — ${data.properties.map((p) => p.address).slice(0, 2).join(' · ')}${data.properties.length > 2 ? '…' : ''}` : ''}
        </div>
        {excessCount > 0 && (
          <div style={{ marginTop: 10, background: '#faf3e2', color: '#8a6414', borderRadius: 9, padding: '9px 12px', fontSize: 13 }}>
            ⚠ {excessCount} recent {excessCount === 1 ? 'pickup was' : 'pickups were'} flagged as over the usual volume — see Pickups for photos{data.excess.some((x) => x.excess.amount != null) ? ' and charges' : ''}.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {TABS.map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{ background: tab === v ? GREEN : '#fff', color: tab === v ? '#fff' : '#5d6b63', border: `1px solid ${tab === v ? GREEN : '#dde2dd'}`, borderRadius: 9, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{l}</button>
        ))}
      </div>

      {tab === 'pickups' && (
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
      )}

      {tab === 'photos' && (
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
      )}

      {tab === 'invoices' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                <span style={{ fontSize: 12, fontWeight: 700, color: GREEN, background: '#e7f1eb', borderRadius: 7, padding: '4px 10px' }}>PAID</span>
              ) : inv.stripe_payment_url ? (
                <a href={inv.stripe_payment_url} target="_blank" rel="noreferrer" style={{ background: GREEN, color: '#fff', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>Pay now</a>
              ) : (
                <span style={{ fontSize: 12, fontWeight: 700, color: '#8a6414', background: '#faf3e2', borderRadius: 7, padding: '4px 10px' }}>OPEN</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ textAlign: 'center', marginTop: 26 }}>
        <button
          onClick={() => { localStorage.removeItem(tokenKey(slug)); setData(null); setPhase('email') }}
          style={{ background: 'none', border: 'none', color: '#9aa69e', fontSize: 12.5, cursor: 'pointer' }}
        >Sign out</button>
      </div>
    </>,
  )
}
