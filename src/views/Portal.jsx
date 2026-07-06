// Client Portal (admin view) — search any client by business name, owner /
// contact, email, or address and see EXACTLY what their portal looks like
// (live data via the portal fn's staff-authorized admin_data action, rendered
// by the same PortalPage component in preview mode). Admins can also copy the
// client's portal link and send them a quote from here.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { logActivity } from '../lib/activityData.js'
import PortalPage from '../portal/PortalPage.jsx'

const GREEN = '#1f7a4d'
const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, padding: '16px 18px' }
const inp = { border: '1px solid #dde2dd', background: '#fff', borderRadius: 10, padding: '10px 13px', fontSize: 14, color: '#1a2420', outline: 'none', width: '100%', boxSizing: 'border-box' }
const btnPrimary = { background: GREEN, color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const btnGhost = { background: '#fff', color: '#5d6b63', border: '1px solid #dde2dd', borderRadius: 9, padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }

async function searchClients(q) {
  const term = q.trim()
  if (!term) return []
  const like = `%${term}%`
  // Business name, owner/contact, email, phone, or the client's own address…
  const { data: byCustomer, error } = await supabase
    .from('customers')
    .select('id, name, contact_name, email, phone, address, portal_slug, autopay_pm_id, autopay_card_brand, autopay_card_last4')
    .or(`name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like},address.ilike.${like}`)
    .order('name')
    .limit(12)
  if (error) throw error
  // …plus clients matched through one of their PROPERTY addresses.
  const { data: props } = await supabase
    .from('properties')
    .select('customer_id, address')
    .ilike('address', like)
    .not('customer_id', 'is', null)
    .limit(12)
  const missing = [...new Set((props || []).map((p) => p.customer_id))].filter((id) => !(byCustomer || []).some((c) => c.id === id))
  let extra = []
  if (missing.length) {
    const { data: more } = await supabase
      .from('customers')
      .select('id, name, contact_name, email, phone, address, portal_slug, autopay_pm_id, autopay_card_brand, autopay_card_last4')
      .in('id', missing)
    extra = (more || []).map((c) => ({ ...c, matched_property: (props || []).find((p) => p.customer_id === c.id)?.address }))
  }
  return [...(byCustomer || []), ...extra]
}

export default function Portal({ app }) {
  const isMobile = app.isMobile
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState(null) // customer row
  const [copied, setCopied] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [previewKey, setPreviewKey] = useState(0) // bump to refetch preview
  const [loginBusy, setLoginBusy] = useState(false)
  const debounceRef = useRef(null)

  // Open the client's REAL portal in a new tab, signed in as them — the portal
  // fn mints a one-time login code (staff JWT required), skipping the email.
  async function signInAsClient() {
    if (!selected || loginBusy) return
    setLoginBusy(true)
    setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('portal', {
        body: { action: 'admin_login', customer_id: selected.id },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      logActivity({ type: 'portal_admin_login', summary: `Admin signed in to ${selected.name}'s portal`, entityType: 'customer', entityId: selected.id })
      window.open(data.url, '_blank', 'noopener')
    } catch (e) {
      setErr(e.message || String(e))
    }
    setLoginBusy(false)
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!query.trim()) { setResults([]); setSearching(false); return }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        setErr('')
        const r = await searchClients(query)
        setResults(r)
      } catch (e) { setErr(e.message || String(e)) }
      setSearching(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [query])

  const portalLink = selected?.portal_slug ? `${window.location.origin}/?portal=${selected.portal_slug}` : null

  function copyLink() {
    if (!portalLink) return
    navigator.clipboard?.writeText(portalLink).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      {/* search */}
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>Preview a client's portal</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82', marginBottom: 12 }}>
          Search by business name, owner or contact, email, phone, or any service address — then see their portal exactly as they do.
        </div>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e', fontSize: 14, pointerEvents: 'none' }}>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Try "JaxBNB", "Sam", "12 Main St"…'
            style={{ ...inp, paddingLeft: 36, fontSize: 15 }}
          />
        </div>
        {err && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 10 }}>{err}</div>}
        {query.trim() && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
            {searching && <div style={{ fontSize: 12.5, color: '#9aa69e', padding: '6px 2px' }}>Searching…</div>}
            {!searching && !results.length && <div style={{ fontSize: 12.5, color: '#9aa69e', padding: '6px 2px' }}>No clients match “{query}”.</div>}
            {results.map((c) => (
              <div
                key={c.id}
                onClick={() => { setSelected(c); setPreviewKey((k) => k + 1) }}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px', borderRadius: 9, cursor: 'pointer', background: selected?.id === c.id ? '#e7f1eb' : '#f7f9f7', border: `1px solid ${selected?.id === c.id ? '#bcd9c8' : 'transparent'}` }}
              >
                <div style={{ width: 32, height: 32, borderRadius: 8, background: GREEN, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flex: 'none' }}>
                  {(c.name || '?')[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[c.contact_name, c.email, c.matched_property ? `matched: ${c.matched_property}` : c.address].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                {c.autopay_pm_id && (
                  <span title={`Autopay on — ${(c.autopay_card_brand || 'card').toUpperCase()} ••${c.autopay_card_last4}`} style={{ fontSize: 11, fontWeight: 700, color: GREEN, background: '#e7f1eb', borderRadius: 7, padding: '3px 8px', flex: 'none' }}>💳 AUTOPAY</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* selected client toolbar + live preview */}
      {selected ? (
        <>
          <div style={{ ...card, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5 }}>{selected.name}</div>
              <div style={{ fontSize: 11.5, color: '#7c8a82' }}>Viewing their portal as they see it (actions disabled)</div>
            </div>
            <button onClick={() => setQuoteOpen(true)} style={btnPrimary}>+ New quote</button>
            {selected.portal_slug && (
              <button
                onClick={signInAsClient} disabled={loginBusy}
                title="Opens their live portal in a new tab, signed in as them — actions are real, no email needed"
                style={{ ...btnGhost, color: GREEN, borderColor: '#bcd9c8', opacity: loginBusy ? 0.6 : 1 }}
              >{loginBusy ? 'Opening…' : '→ Sign in as client'}</button>
            )}
            {portalLink && (
              <button onClick={copyLink} style={btnGhost}>{copied ? '✓ Copied' : 'Copy portal link'}</button>
            )}
            <button onClick={() => setSelected(null)} style={{ ...btnGhost, padding: '9px 11px' }}>✕</button>
          </div>

          <div style={{ border: '1px solid #dfe5df', borderRadius: 16, overflow: 'hidden', boxShadow: '0 10px 30px rgba(15,30,20,.06)' }}>
            <PortalPage key={`${selected.id}-${previewKey}`} previewCustomerId={selected.id} />
          </div>
        </>
      ) : (
        <div style={{ ...card, textAlign: 'center', padding: '48px 28px', border: '1px dashed #d8ddd6', background: 'transparent' }}>
          <div style={{ fontSize: 26, marginBottom: 10 }}>◫</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Search for a client above to preview their portal</div>
          <div style={{ fontSize: 12.5, color: '#7c8a82', maxWidth: 480, margin: '0 auto', lineHeight: 1.55 }}>
            Clients reach their portal from their shareable link or the client sign-in on the app's login page.
            They see pickups with photos, invoices with Pay now, quotes to approve, and can save a card
            (5th week free) or request service — requests and card saves text every admin via Trashy Randy.
          </div>
        </div>
      )}

      {quoteOpen && selected && (
        <QuoteModal
          customer={selected}
          isMobile={isMobile}
          onClose={() => setQuoteOpen(false)}
          onCreated={() => { setQuoteOpen(false); setPreviewKey((k) => k + 1) }}
        />
      )}
    </div>
  )
}

// ---- New quote modal ------------------------------------------------------------
function QuoteModal({ customer, isMobile, onClose, onCreated }) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState([{ description: '', quantity: 1, unit_price: '' }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const lineAmount = (li) => Number(li.quantity || 1) * Number(li.unit_price || 0)
  const total = items.reduce((s, li) => s + lineAmount(li), 0)

  function setItem(i, patch) {
    setItems((prev) => prev.map((li, j) => (j === i ? { ...li, ...patch } : li)))
  }

  async function save() {
    const clean = items
      .filter((li) => li.description.trim() && Number(li.unit_price) > 0)
      .map((li, i) => ({ description: li.description.trim(), quantity: Number(li.quantity || 1), unit_price: Number(li.unit_price), amount: lineAmount(li), position: i }))
    if (!clean.length) { setErr('Add at least one line item with a description and price.'); return }
    setBusy(true)
    setErr('')
    try {
      const subtotal = clean.reduce((s, li) => s + li.amount, 0)
      const { data: me } = await supabase.auth.getUser()
      const { error } = await supabase.from('quotes').insert({
        customer_id: customer.id,
        title: title.trim() || null,
        notes: notes.trim() || null,
        line_items: clean,
        subtotal,
        total: subtotal,
        status: 'sent',
        sent_at: new Date().toISOString(),
        created_by: me?.user?.email || null,
      })
      if (error) throw error
      onCreated()
    } catch (e) { setErr(e.message || String(e)); setBusy(false) }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500 }} />
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: isMobile ? 'calc(100vw - 24px)' : 520, maxHeight: '86vh', overflowY: 'auto', background: '#fff', borderRadius: 16, padding: 22, zIndex: 510, boxShadow: '0 24px 60px rgba(15,30,20,.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>New quote — {customer.name}</div>
            <div style={{ fontSize: 12, color: '#7c8a82' }}>Shows up in their portal immediately for approval; Randy texts all admins when they respond.</div>
          </div>
          <span onClick={onClose} style={{ cursor: 'pointer', color: '#7c8a82', fontSize: 17, padding: 4 }}>✕</span>
        </div>

        <label style={lbl}>Title (optional)</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder='e.g. "Add twice-weekly pickup at 44 Oak Ave"' style={inp} />

        <label style={{ ...lbl, marginTop: 14 }}>Line items</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((li, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <input value={li.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Description" style={{ ...inp, flex: 1 }} />
              <input value={li.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} type="number" min="1" style={{ ...inp, width: 62 }} title="Qty" />
              <input value={li.unit_price} onChange={(e) => setItem(i, { unit_price: e.target.value })} type="number" min="0" step="0.01" placeholder="$" style={{ ...inp, width: 96 }} title="Unit price" />
              {items.length > 1 && (
                <button onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))} style={{ ...btnGhost, padding: '0 10px' }}>✕</button>
              )}
            </div>
          ))}
        </div>
        <button onClick={() => setItems((prev) => [...prev, { description: '', quantity: 1, unit_price: '' }])} style={{ background: 'none', border: 'none', color: GREEN, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '8px 0 0' }}>+ Add line</button>

        <label style={{ ...lbl, marginTop: 12 }}>Notes to the client (optional)</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />

        {err && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>Total ${total.toFixed(2)}</div>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.7 : 1 }}>{busy ? 'Sending…' : 'Send quote'}</button>
        </div>
      </div>
    </>
  )
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#5d6b63', marginBottom: 6, marginTop: 0 }
