// Estimates board — the "Estimates" side of the Invoicing tab. Estimates
// (stored as quotes) are laid out exactly like invoices — same masthead,
// line-item table, totals, notes/terms, print + PDF — except there is no
// payment anywhere: the client accepts or declines, with an optional note why.
// This pane is the staff view: list, document detail, create/edit, text/email
// the accept link, void, and one-click convert into a draft invoice.
import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { supabase } from '../lib/supabaseClient.js'
import { loadCustomers } from '../lib/customersData.js'
import { loadSettings } from '../lib/settingsData.js'
import { RichTextEditor } from '../components/RichText.jsx'
import EstimateDoc, { ESTIMATE_STATUS } from '../components/EstimateDoc.jsx'
import { printInvoiceDoc, downloadInvoicePdf } from '../lib/printInvoice.js'
import {
  loadEstimates, createEstimate, updateEstimate, voidEstimate,
  estimateUrl, emailEstimate, textEstimate, convertEstimateToInvoice,
} from '../lib/estimatesData.js'

const money = (v) => '$' + Number(v || 0).toFixed(2)
const initialsOf = (name) => (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const fmtDT = (ts) => { try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return ts } }

const inp = { background: '#fff', border: '1px solid #d9e2dc', borderRadius: 9, padding: '8px 11px', fontSize: 13, color: '#1a2420', outline: 'none' }
const primaryBtn = { background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const ghostBtn = { background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const dangerBtn = { background: '#fff', border: '1px solid #eccfc7', color: '#c0492f', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const FILTERS = [['all', 'All'], ['sent', 'Awaiting'], ['approved', 'Accepted'], ['declined', 'Declined'], ['void', 'Void']]
const blankItem = () => ({ title: '', description: '', quantity: 1, unitPrice: '' })
const blankForm = () => ({ customerId: '', title: '', notes: '', items: [blankItem()] })

export default function EstimatesBoard({ app }) {
  const isMobile = app.isMobile
  const [estimates, setEstimates] = useState(null)
  const [customers, setCustomers] = useState([])
  const [settings, setSettings] = useState(null)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selId, setSelId] = useState(null)
  const [busy, setBusy] = useState(false)

  const [formOpen, setFormOpen] = useState(false)
  const [editId, setEditId] = useState(null) // estimate id when editing
  const [form, setForm] = useState(blankForm())
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState('')

  async function refresh() {
    const rows = await loadEstimates(app.activeLine)
    setEstimates(rows)
    setSelId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id || null))
  }

  useEffect(() => {
    refresh().catch((e) => setErr(e.message || String(e)))
    loadCustomers().then(setCustomers).catch(() => {})
    loadSettings().then(setSettings).catch(() => {})
  }, [app.activeLine])

  // Live updates when a client accepts/declines from the portal or accept page.
  useEffect(() => {
    const channel = supabase
      .channel('quotes-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quotes' }, () => { refresh().catch(() => {}) })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [app.activeLine])

  const company = useMemo(() => ({
    name: settings?.company_name,
    logoUrl: settings?.logo_url,
    phone: settings?.company_phone,
    email: settings?.company_email,
    address: settings?.company_address,
    terms: settings?.invoice_terms,
  }), [settings])

  const q = (search || '').trim().toLowerCase()
  const list = useMemo(() => (estimates || []).filter((e) => {
    if (filter !== 'all' && e.status !== filter) return false
    if (!q) return true
    return (e.customerName || '').toLowerCase().includes(q) || (e.number || '').toLowerCase().includes(q)
  }), [estimates, filter, q])

  const sel = (estimates || []).find((e) => e.id === selId) || null

  function openCreate() {
    setEditId(null)
    setForm(blankForm())
    setFormErr('')
    setFormOpen(true)
  }
  function openEdit(est) {
    setEditId(est.id)
    setForm({
      customerId: est.customerId,
      title: est.title,
      notes: est.notes,
      items: est.lineItems.map((li) => ({ title: li.title, description: li.description, quantity: li.quantity, unitPrice: li.unitPrice })),
    })
    setFormErr('')
    setFormOpen(true)
  }

  async function save() {
    if (!form.customerId) { setFormErr('Pick a client first.'); return }
    setSaving(true)
    setFormErr('')
    try {
      const cust = customers.find((c) => c.id === form.customerId)
      if (editId) await updateEstimate(editId, { ...form, number: sel?.number })
      else await createEstimate({ ...form, customerName: cust?.name })
      setFormOpen(false)
      await refresh()
      setNotice(editId ? 'Estimate updated — the client sees the new version in their portal.' : `Estimate sent to ${cust?.name || 'client'} — it's in their portal waiting for accept/decline.`)
    } catch (e) {
      setFormErr(e.message || String(e))
    }
    setSaving(false)
  }

  async function act(fn, okMsg) {
    setBusy(true)
    setErr('')
    setNotice('')
    try {
      await fn()
      if (okMsg) setNotice(okMsg)
      await refresh()
    } catch (e) {
      setErr(e.message || String(e))
    }
    setBusy(false)
  }

  const copyLink = (est) => act(async () => {
    const url = await estimateUrl(est.id)
    try { await navigator.clipboard.writeText(url); setNotice('Accept link copied — paste it anywhere.') }
    catch (_e) { window.prompt('Copy this accept link:', url) }
  })

  const counts = useMemo(() => {
    const c = { all: estimates?.length || 0, sent: 0, approved: 0, declined: 0, void: 0 }
    for (const e of estimates || []) c[e.status] = (c[e.status] || 0) + 1
    return c
  }, [estimates])

  return (
    <div>
      {/* summary + new */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <SummaryCard label="Awaiting response" value={String(counts.sent)} accent="#8a6414" />
        <SummaryCard label="Accepted" value={String(counts.approved)} accent="#1f7a4d" />
        <SummaryCard label="Declined" value={String(counts.declined)} accent="#c0492f" />
        <div style={{ flex: 1 }} />
        <button onClick={openCreate} style={{ alignSelf: 'center', ...primaryBtn }}>+ New estimate</button>
      </div>

      {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '9px 13px', fontSize: 12.5, marginBottom: 14 }}>{err}</div>}
      {notice && (
        <div style={{ marginBottom: 14, background: '#eef7f1', border: '1px solid #cfe7da', color: '#1f7a4d', borderRadius: 11, padding: '9px 13px', fontSize: 12.5, display: 'flex', gap: 8 }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button onClick={() => setNotice('')} style={{ background: 'none', border: 'none', color: '#1f7a4d', fontSize: 15, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '0.85fr 1.15fr', gap: 18 }}>
        {/* list */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
          <div style={{ position: 'relative', padding: '4px 4px 8px' }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by client or estimate #…" style={{ ...inp, fontSize: 13, padding: '8px 30px 8px 11px', width: '100%', boxSizing: 'border-box' }} />
            {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9aa69e', fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>}
          </div>
          <div style={{ display: 'flex', gap: 5, padding: '4px 4px 8px', flexWrap: 'wrap' }}>
            {FILTERS.map(([id, label]) => {
              const on = filter === id
              const n = id === 'all' ? counts.all : counts[id] || 0
              return (
                <button key={id} onClick={() => setFilter(id)} style={{ background: on ? '#1f7a4d' : '#f3f5f2', color: on ? '#fff' : '#5d6b63', border: 'none', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{label} {n ? `· ${n}` : ''}</button>
              )
            })}
          </div>

          {estimates === null && <div style={{ padding: 32, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading estimates…</div>}
          {estimates !== null && !estimates.length && <div style={{ padding: 32, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>No estimates yet. Create your first with “New estimate”.</div>}
          {estimates !== null && !!estimates.length && !list.length && <div style={{ padding: 32, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>No estimates match.</div>}

          {list.map((est) => {
            const on = est.id === selId
            const meta = ESTIMATE_STATUS[est.status] || ESTIMATE_STATUS.sent
            return (
              <div key={est.id} onClick={() => setSelId(est.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 2, background: on ? '#f3faf5' : '#fff', border: `1px solid ${on ? '#cfe0d5' : 'transparent'}` }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 11, flex: 'none' }}>{initialsOf(est.customerName)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{est.customerName || 'Unknown'}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>
                    {est.number}{est.responseNote ? ' · 🗒 note' : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{money(est.total)}</div>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: meta.color, background: meta.bg, padding: '1px 6px', borderRadius: 5 }}>{meta.label.toUpperCase()}</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* detail */}
        <div>
          {sel ? (
            <EstimateDoc
              estimate={sel}
              customer={{ name: sel.customerName, email: sel.customerEmail, phone: sel.customerPhone, address: sel.customerAddress }}
              company={company}
            >
              <button onClick={() => printInvoiceDoc(sel.number, 'Estimate')} disabled={busy} style={ghostBtn}>🖨 Print</button>
              <button onClick={() => act(() => downloadInvoicePdf(sel.number, 'Estimate'))} disabled={busy} style={ghostBtn}>{busy ? 'Building…' : '⬇ Download PDF'}</button>
              {sel.status === 'sent' && (
                <>
                  <button onClick={() => act(() => textEstimate(sel), 'Text sent with the accept link.')} disabled={busy || !sel.customerPhone} title={sel.customerPhone ? undefined : 'No phone on file'} style={ghostBtn}>💬 Text</button>
                  <button onClick={() => act(() => emailEstimate(sel.id), 'Estimate emailed with an Accept button.')} disabled={busy || !sel.customerEmail} title={sel.customerEmail ? undefined : 'No email on file'} style={ghostBtn}>✉ Email</button>
                  <button onClick={() => copyLink(sel)} disabled={busy} style={ghostBtn}>🔗 Copy link</button>
                  <button onClick={() => openEdit(sel)} disabled={busy} style={ghostBtn}>✎ Edit</button>
                  <button onClick={() => act(() => voidEstimate(sel), `Estimate ${sel.number} voided.`)} disabled={busy} style={dangerBtn}>Void</button>
                </>
              )}
              {sel.status === 'approved' && (
                <button onClick={() => act(async () => {
                  const invId = await convertEstimateToInvoice(sel)
                  setNotice(`Draft invoice created from ${sel.number} — review it in the Invoices list, then send.`)
                  return invId
                })} disabled={busy} style={{ ...primaryBtn, ...{ background: '#fff', color: '#1f7a4d', border: '1px solid #1f7a4d' } }}>→ Convert to invoice</button>
              )}
              {(sel.status === 'declined' || sel.status === 'void') && sel.status !== 'sent' && (
                <button onClick={() => act(() => convertEstimateToInvoice(sel), 'Draft invoice created — edit it before sending if the scope changed.')} disabled={busy} style={ghostBtn}>→ Convert anyway</button>
              )}
            </EstimateDoc>
          ) : (
            <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 13, padding: '40px 22px', textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>
              Pick an estimate to see the full document — or create one with “+ New estimate”.
            </div>
          )}
        </div>
      </div>

      {/* create / edit modal */}
      {formOpen && (
        <EstimateForm
          form={form} setForm={setForm} customers={customers} editing={!!editId}
          busy={saving} err={formErr}
          onCancel={() => setFormOpen(false)} onSave={save}
        />
      )}
    </div>
  )
}

function SummaryCard({ label, value, accent }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '10px 16px', minWidth: 130 }}>
      <div style={{ fontSize: 11, color: '#7c8a82', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: accent, marginTop: 2 }}>{value}</div>
    </div>
  )
}

// Create/edit modal — same shape as the invoice form's essentials: client,
// title, line items (title + rich description + qty + price), notes, total.
function EstimateForm({ form, setForm, customers, editing, busy, err, onCancel, onSave }) {
  const [clientQ, setClientQ] = useState('')
  const selected = customers.find((c) => c.id === form.customerId) || null
  const matches = useMemo(() => {
    const q = clientQ.trim().toLowerCase()
    if (!q) return []
    return customers.filter((c) => (c.name || '').toLowerCase().includes(q)).slice(0, 6)
  }, [clientQ, customers])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setItem = (i, patch) => set({ items: form.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) })
  const lineAmount = (it) => Number(it.quantity || 1) * Number(it.unitPrice || 0)
  const total = form.items.reduce((s, it) => s + lineAmount(it), 0)

  return (
    <>
      <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 200 }} />
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 'min(640px, calc(100vw - 28px))', maxHeight: '88vh', overflowY: 'auto', background: '#fff', borderRadius: 16, padding: 22, zIndex: 210, boxShadow: '0 24px 60px rgba(15,30,20,.3)' }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 14 }}>{editing ? 'Edit estimate' : 'New estimate'}</div>

        {!editing && (
          <>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 6 }}>CLIENT</div>
            <div style={{ position: 'relative', marginBottom: 14 }}>
              <input
                value={selected ? selected.name : clientQ}
                onChange={(e) => { setClientQ(e.target.value); set({ customerId: '' }) }}
                placeholder="Search clients…"
                style={{ ...inp, width: '100%', fontSize: 13.5 }}
                readOnly={!!selected}
              />
              {selected && (
                <button onClick={() => { set({ customerId: '' }); setClientQ('') }} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9aa69e', fontSize: 16, cursor: 'pointer' }}>×</button>
              )}
              {!selected && matches.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: '#fff', border: '1px solid #e0e7e2', borderRadius: 10, boxShadow: '0 8px 24px rgba(20,40,30,.14)', zIndex: 20, overflow: 'hidden' }}>
                  {matches.map((c) => (
                    <div key={c.id} onClick={() => { set({ customerId: c.id }); setClientQ('') }} style={{ padding: '9px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f2f4f2' }}>
                      {c.name}{c.email ? <span style={{ color: '#9aa69e' }}> · {c.email}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 6 }}>TITLE (OPTIONAL)</div>
        <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder='e.g. "Add twice-weekly pickup at 44 Oak Ave"' style={{ ...inp, width: '100%', marginBottom: 14 }} />

        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', margin: '4px 0 8px' }}>LINE ITEMS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {form.items.map((it, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 80px 64px 24px', gap: 7, alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <input value={it.title} onChange={(e) => setItem(idx, { title: e.target.value })} style={{ ...inp, fontSize: 13, fontWeight: 600 }} placeholder="Title — e.g. Weekly valet trash" />
                <RichTextEditor
                  value={it.description}
                  onChange={(v) => setItem(idx, { description: v })}
                  placeholder="Description — B, I, U, bullets supported"
                  rows={2}
                />
              </div>
              <input value={it.quantity} onChange={(e) => setItem(idx, { quantity: e.target.value })} style={{ ...inp, fontSize: 13, textAlign: 'center' }} type="number" step="any" placeholder="Qty" />
              <input value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: e.target.value })} style={{ ...inp, fontSize: 13, textAlign: 'right' }} type="number" step="0.01" placeholder="$" />
              <div style={{ fontFamily: MONO, fontSize: 12.5, textAlign: 'right', color: '#5d6b63', paddingTop: 66 }}>{money(lineAmount(it))}</div>
              <button onClick={() => set({ items: form.items.filter((_, j) => j !== idx) })} style={{ background: 'none', border: 'none', color: '#c0492f', fontSize: 16, cursor: 'pointer', padding: 0, paddingTop: 8 }} title="Remove line">×</button>
            </div>
          ))}
        </div>
        <button onClick={() => set({ items: [...form.items, blankItem()] })} style={{ marginTop: 9, background: '#f3f5f2', border: '1px solid #e6eae6', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: '#1f7a4d', cursor: 'pointer' }}>+ Add line</button>

        <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, alignItems: 'start' }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 6 }}>NOTES TO THE CLIENT (OPTIONAL)</div>
            <textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} style={{ ...inp, minHeight: 70, resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }} placeholder="Anything about the work, timing, exclusions…" />
          </div>
          <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', margin: '6px 0', fontSize: 12, color: '#7c8a82' }}><span>Subtotal</span><span>{money(total)}</span></div>
            <div style={{ height: 1, background: '#e6eae6', margin: '8px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={{ fontSize: 13, color: '#7c8a82' }}>Total</span><span style={{ fontWeight: 800, fontSize: 17 }}>{money(total)}</span></div>
          </div>
        </div>

        {err && <div style={{ color: '#c0492f', fontSize: 12.5, marginTop: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 9, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={busy} style={{ ...inp, cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
          <button onClick={onSave} disabled={busy || (!editing && !form.customerId)} style={{ ...primaryBtn, opacity: busy || (!editing && !form.customerId) ? 0.6 : 1 }}>
            {busy ? 'Saving…' : editing ? 'Save estimate' : 'Send estimate'}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 8 }}>
          {editing ? 'The client sees the updated document in their portal immediately.' : 'Goes straight to the client’s portal for accept / decline — then text or email it from the detail pane.'}
        </div>
      </div>
    </>
  )
}
