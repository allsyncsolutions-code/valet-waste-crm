import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import { loadCustomers } from '../lib/customersData.js'
import { stripeStatus } from '../lib/stripeData.js'
import {
  loadInvoices,
  createInvoice,
  updateInvoice,
  markPaid,
  deleteInvoice,
  sendInvoiceLink,
  textInvoice,
  subscribeInvoices,
  invoiceTotals,
  lineAmount,
  round2,
} from '../lib/invoicesData.js'

const money = (v) => '$' + Number(v || 0).toFixed(2)
const initialsOf = (name) =>
  (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

const STATUS_META = {
  draft: { label: 'Draft', color: '#7c8a82', bg: '#eef0ed' },
  sent: { label: 'Sent', color: '#b07a1e', bg: '#fdf2e0' },
  paid: { label: 'Paid', color: '#1f7a4d', bg: '#e7f1eb' },
  void: { label: 'Void', color: '#9a2c1e', bg: '#fdecea' },
}
const FILTERS = [['all', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['paid', 'Paid']]
const today = () => new Date().toISOString().slice(0, 10)
const blankLine = () => ({ description: '', quantity: 1, unitPrice: '' })
const blankForm = () => ({ customerId: '', issueDate: today(), dueDate: '', notes: '', discount: '', items: [blankLine()] })

export default function Invoices({ app }) {
  const isMobile = app.isMobile
  const [invoices, setInvoices] = useState([])
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [filter, setFilter] = useState('all')
  const [selId, setSelId] = useState(null)
  const [stripeOk, setStripeOk] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(blankForm())

  const [busy, setBusy] = useState(false) // detail-pane action in flight

  async function refresh() {
    const rows = await loadInvoices()
    setInvoices(rows)
    setSelId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id || null))
  }

  useEffect(() => {
    if (!hasSupabase) {
      setErr('Supabase env vars not set — check .env.local')
      setLoading(false)
      return
    }
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    loadCustomers().then(setCustomers).catch(() => {})
    stripeStatus().then((d) => setStripeOk(!!(d && d.connected && d.chargesEnabled))).catch(() => {})
    const unsub = subscribeInvoices(() => refresh().catch(() => {}))
    return () => unsub && unsub()
  }, [])

  const list = useMemo(
    () => (filter === 'all' ? invoices : invoices.filter((i) => i.status === filter)),
    [invoices, filter]
  )
  const cur = invoices.find((i) => i.id === selId) || null

  const outstanding = round2(invoices.filter((i) => i.status === 'sent').reduce((s, i) => s + i.total, 0))
  const paidTotal = round2(invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.total, 0))
  const draftCount = invoices.filter((i) => i.status === 'draft').length

  // ---- form helpers ----
  const setF = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setItem = (idx, patch) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }))
  const addLine = () => setForm((f) => ({ ...f, items: [...f.items, blankLine()] }))
  const removeLine = (idx) => setForm((f) => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, i) => i !== idx) : f.items }))
  const { subtotal, total } = invoiceTotals(form.items, form.discount)

  function openCreate() {
    setEditId(null)
    setForm({ ...blankForm(), customerId: customers[0]?.id || '' })
    setShowForm(true)
  }
  function openEdit(inv) {
    setEditId(inv.id)
    setForm({
      customerId: inv.customerId,
      issueDate: inv.issueDate || today(),
      dueDate: inv.dueDate || '',
      notes: inv.notes || '',
      discount: inv.discount ? String(inv.discount) : '',
      items: inv.items.length ? inv.items.map((it) => ({ description: it.description, quantity: it.quantity, unitPrice: it.unitPrice })) : [blankLine()],
    })
    setShowForm(true)
  }

  async function submit(e) {
    e.preventDefault()
    if (!form.customerId) { setErr('Pick a customer for this invoice.'); return }
    setSaving(true)
    setErr(null)
    try {
      if (editId) {
        const inv = invoices.find((i) => i.id === editId)
        await updateInvoice(editId, { ...form, status: inv?.status || 'draft' })
        setShowForm(false)
        await refresh()
        setSelId(editId)
      } else {
        const id = await createInvoice(form)
        setShowForm(false)
        await refresh()
        setSelId(id)
      }
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setSaving(false)
    }
  }

  async function action(fn) {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }
  const onMarkPaid = () => action(() => markPaid(cur.id, cur.number))
  const onSend = () => action(async () => { await sendInvoiceLink(cur) })
  const onText = () => action(async () => { await textInvoice(cur) })
  async function onDelete() {
    if (!cur || !window.confirm(`Delete invoice ${cur.number}? This can’t be undone.`)) return
    const id = cur.id
    const number = cur.number
    await action(async () => {
      await deleteInvoice(id, number)
      setSelId(null)
    })
  }

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      {/* summary */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <SummaryCard label="Outstanding" value={money(outstanding)} sub={`${invoices.filter((i) => i.status === 'sent').length} sent`} accent="#b07a1e" />
        <SummaryCard label="Collected" value={money(paidTotal)} sub={`${invoices.filter((i) => i.status === 'paid').length} paid`} accent="#1f7a4d" />
        <SummaryCard label="Drafts" value={String(draftCount)} sub="not sent yet" accent="#7c8a82" />
        <div style={{ flex: 1 }} />
        <button onClick={openCreate} disabled={!customers.length} style={{ alignSelf: 'center', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 17px', fontSize: 13.5, fontWeight: 600, cursor: customers.length ? 'pointer' : 'default', opacity: customers.length ? 1 : 0.5 }} title={customers.length ? '' : 'Add a client first'}>+ New invoice</button>
      </div>

      {err && <div style={errorBox}>{err}</div>}
      {!stripeOk && !loading && (
        <div style={{ marginBottom: 14, background: '#fff7e9', border: '1px solid #f0dcb0', color: '#8a6320', borderRadius: 11, padding: '9px 13px', fontSize: 12.5 }}>
          Stripe isn’t connected yet — you can still create and edit invoices, but “Send payment link” needs Stripe set up in Settings → Payments.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '0.85fr 1.15fr', gap: 18 }}>
        {/* list */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
          <div style={{ display: 'flex', gap: 5, padding: '4px 4px 8px', flexWrap: 'wrap' }}>
            {FILTERS.map(([id, label]) => {
              const on = filter === id
              const n = id === 'all' ? invoices.length : invoices.filter((i) => i.status === id).length
              return (
                <button key={id} onClick={() => setFilter(id)} style={{ background: on ? '#1f7a4d' : '#f3f5f2', color: on ? '#fff' : '#5d6b63', border: 'none', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{label} {n ? `· ${n}` : ''}</button>
              )
            })}
          </div>

          {loading && <div style={empty}>Loading invoices…</div>}
          {!loading && !invoices.length && <div style={empty}>No invoices yet. Create your first with “New invoice”.</div>}
          {!loading && !!invoices.length && !list.length && <div style={empty}>No {filter} invoices.</div>}

          {list.map((inv) => {
            const on = inv.id === selId
            const meta = STATUS_META[inv.status] || STATUS_META.draft
            return (
              <div key={inv.id} onClick={() => setSelId(inv.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 10px', borderRadius: 10, cursor: 'pointer', marginBottom: 2, background: on ? '#f3faf5' : '#fff', border: `1px solid ${on ? '#cfe0d5' : 'transparent'}` }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: '#e7f1eb', color: '#1f7a4d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 11, flex: 'none' }}>{initialsOf(inv.customerName)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inv.customerName || 'Unknown'}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{inv.number}</div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{money(inv.total)}</div>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: meta.color, background: meta.bg, padding: '1px 6px', borderRadius: 5 }}>{meta.label}</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* detail */}
        <div>
          {!cur && !loading && (
            <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 13, padding: '46px 22px', textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>
              Select an invoice, or create a new one.
            </div>
          )}
          {cur && <InvoiceDetail inv={cur} stripeOk={stripeOk} busy={busy} onEdit={() => openEdit(cur)} onMarkPaid={onMarkPaid} onSend={onSend} onText={onText} onDelete={onDelete} />}
        </div>
      </div>

      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={overlay}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ ...modal, width: 620 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{editId ? 'Edit invoice' : 'New invoice'}</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 16 }}>Add line items — the total updates as you type.</div>

            <div style={twoCol}>
              <Field label="Customer *">
                <select value={form.customerId} onChange={(e) => setF({ customerId: e.target.value })} style={inp} disabled={!!editId}>
                  <option value="">Select…</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <div style={twoCol}>
                <Field label="Issue date"><input value={form.issueDate || ''} onChange={(e) => setF({ issueDate: e.target.value })} style={inp} type="date" /></Field>
                <Field label="Due date"><input value={form.dueDate || ''} onChange={(e) => setF({ dueDate: e.target.value })} style={inp} type="date" /></Field>
              </div>
            </div>

            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', margin: '8px 0 8px', paddingTop: 10, borderTop: '1px solid #eef0ed' }}>LINE ITEMS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {form.items.map((it, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 80px 64px 24px', gap: 7, alignItems: 'center' }}>
                  <input value={it.description} onChange={(e) => setItem(idx, { description: e.target.value })} style={{ ...inp, fontSize: 13 }} placeholder="Description" />
                  <input value={it.quantity} onChange={(e) => setItem(idx, { quantity: e.target.value })} style={{ ...inp, fontSize: 13, textAlign: 'center' }} type="number" step="any" placeholder="Qty" />
                  <input value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: e.target.value })} style={{ ...inp, fontSize: 13, textAlign: 'right' }} type="number" step="0.01" placeholder="Price" />
                  <div style={{ fontFamily: MONO, fontSize: 12.5, textAlign: 'right', color: '#5d6b63' }}>{money(lineAmount(it))}</div>
                  <button type="button" onClick={() => removeLine(idx)} style={{ background: 'none', border: 'none', color: '#c0492f', fontSize: 16, cursor: 'pointer', padding: 0 }} title="Remove line">×</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addLine} style={{ marginTop: 9, background: '#f3f5f2', border: '1px solid #e6eae6', borderRadius: 8, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, color: '#1f7a4d', cursor: 'pointer' }}>+ Add line</button>

            <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, alignItems: 'start' }}>
              <Field label="Notes"><textarea value={form.notes} onChange={(e) => setF({ notes: e.target.value })} style={{ ...inp, minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} placeholder="Payment terms, thank-you note…" /></Field>
              <div style={{ background: '#f7f9f7', borderRadius: 10, padding: '12px 14px' }}>
                <TotalRow label="Subtotal" value={money(subtotal)} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '6px 0' }}>
                  <span style={{ fontSize: 12, color: '#7c8a82' }}>Discount</span>
                  <input value={form.discount} onChange={(e) => setF({ discount: e.target.value })} style={{ width: 78, border: '1px solid #dde2dd', borderRadius: 7, padding: '5px 8px', fontSize: 13, textAlign: 'right', boxSizing: 'border-box' }} type="number" step="0.01" placeholder="0.00" />
                </div>
                <div style={{ height: 1, background: '#e6eae6', margin: '8px 0' }} />
                <TotalRow label="Total" value={money(total)} bold />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
              <button type="button" onClick={() => setShowForm(false)} disabled={saving} style={cancelBtn}>Cancel</button>
              <button type="submit" disabled={saving || !form.customerId} style={{ ...primaryBtn, opacity: saving || !form.customerId ? 0.6 : 1 }}>{saving ? 'Saving…' : editId ? 'Save invoice' : 'Create invoice'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function InvoiceDetail({ inv, stripeOk, busy, onEdit, onMarkPaid, onSend, onText, onDelete }) {
  const meta = STATUS_META[inv.status] || STATUS_META.draft
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
      {/* header */}
      <div style={{ padding: '20px 22px', borderBottom: '1px solid #f0f2ef', display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: '#9aa69e' }}>{inv.number}</div>
          <div style={{ fontWeight: 700, fontSize: 19, marginTop: 2 }}>{inv.customerName || 'Unknown customer'}</div>
          {inv.customerAddress && <div style={{ fontSize: 12.5, color: '#7c8a82' }}>{inv.customerAddress}</div>}
        </div>
        <span style={{ flex: 'none', fontFamily: MONO, fontSize: 11, color: meta.color, background: meta.bg, padding: '4px 11px', borderRadius: 7, fontWeight: 600 }}>{meta.label.toUpperCase()}</span>
      </div>

      {/* meta row */}
      <div style={{ display: 'flex', gap: 22, padding: '12px 22px', borderBottom: '1px solid #f0f2ef', flexWrap: 'wrap' }}>
        <MetaItem label="Issued" value={fmtDate(inv.issueDate)} />
        <MetaItem label="Due" value={fmtDate(inv.dueDate)} />
        {inv.customerEmail && <MetaItem label="Email" value={inv.customerEmail} />}
        {inv.paidAt && <MetaItem label="Paid" value={new Date(inv.paidAt).toLocaleDateString()} />}
      </div>

      {/* line items */}
      <div style={{ padding: '14px 22px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 50px 90px 90px', gap: 8, padding: '0 0 8px', fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#9aa69e', borderBottom: '1px solid #f0f2ef' }}>
          <div>DESCRIPTION</div><div style={{ textAlign: 'center' }}>QTY</div><div style={{ textAlign: 'right' }}>PRICE</div><div style={{ textAlign: 'right' }}>AMOUNT</div>
        </div>
        {inv.items.length === 0 && <div style={{ padding: '12px 0', color: '#9aa69e', fontSize: 12.5 }}>No line items.</div>}
        {inv.items.map((it) => (
          <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1fr 50px 90px 90px', gap: 8, padding: '9px 0', borderBottom: '1px solid #f5f6f4', fontSize: 13 }}>
            <div>{it.description || '—'}</div>
            <div style={{ textAlign: 'center', fontFamily: MONO, color: '#5d6b63' }}>{it.quantity}</div>
            <div style={{ textAlign: 'right', fontFamily: MONO, color: '#5d6b63' }}>{money(it.unitPrice)}</div>
            <div style={{ textAlign: 'right', fontFamily: MONO }}>{money(it.amount)}</div>
          </div>
        ))}

        {/* totals */}
        <div style={{ marginLeft: 'auto', width: 220, marginTop: 12 }}>
          <TotalRow label="Subtotal" value={money(inv.subtotal)} />
          {inv.discount > 0 && <TotalRow label="Discount" value={'– ' + money(inv.discount)} />}
          <div style={{ height: 1, background: '#e6eae6', margin: '8px 0' }} />
          <TotalRow label="Total" value={money(inv.total)} bold />
        </div>
      </div>

      {inv.notes && (
        <div style={{ padding: '0 22px 14px' }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#9aa69e', marginBottom: 5 }}>NOTES</div>
          <div style={{ fontSize: 12.5, color: '#5d6b63', whiteSpace: 'pre-wrap' }}>{inv.notes}</div>
        </div>
      )}

      {/* pay link */}
      {inv.stripePaymentUrl && (
        <div style={{ margin: '0 22px 14px', display: 'flex', gap: 8, alignItems: 'center', background: '#f3f1ff', border: '1px solid #ddd6ff', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: '#5b54c9', fontWeight: 600 }}>Stripe payment link</div>
            <input readOnly value={inv.stripePaymentUrl} onFocus={(e) => e.target.select()} style={{ width: '100%', border: '1px solid #ddd6ff', background: '#fff', borderRadius: 7, padding: '6px 9px', fontSize: 11.5, marginTop: 5, boxSizing: 'border-box' }} />
          </div>
          <a href={inv.stripePaymentUrl} target="_blank" rel="noreferrer" style={{ flex: 'none', background: '#635bff', color: '#fff', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>Open</a>
        </div>
      )}

      {/* actions */}
      <div style={{ display: 'flex', gap: 9, padding: '14px 22px', borderTop: '1px solid #f0f2ef', flexWrap: 'wrap' }}>
        {inv.status === 'draft' && <button onClick={onEdit} disabled={busy} style={ghostBtn}>Edit</button>}
        {inv.status !== 'paid' && stripeOk && (
          <button onClick={onSend} disabled={busy} style={{ background: '#635bff', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Working…' : inv.stripePaymentUrl ? 'Resend link' : 'Send payment link'}</button>
        )}
        {inv.status !== 'paid' && (
          <button onClick={onText} disabled={busy || !inv.customerPhone} title={inv.customerPhone ? '' : 'No phone number on file for this customer'} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: inv.customerPhone ? 'pointer' : 'not-allowed', opacity: busy || !inv.customerPhone ? 0.5 : 1 }}>{busy ? 'Working…' : 'Text invoice'}</button>
        )}
        {inv.status !== 'paid' && <button onClick={onMarkPaid} disabled={busy} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>Mark paid</button>}
        <div style={{ flex: 1 }} />
        <button onClick={onDelete} disabled={busy} style={{ background: '#fff', border: '1px solid #f0c9c2', color: '#c0492f', borderRadius: 9, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '12px 16px', minWidth: 150 }}>
      <div style={{ fontSize: 11, color: '#7c8a82' }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 21, fontWeight: 600, color: accent, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: '#9aa69e' }}>{sub}</div>
    </div>
  )
}
function MetaItem({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.08em', color: '#9aa69e' }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 12.5, marginTop: 2 }}>{value}</div>
    </div>
  )
}
function TotalRow({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' }}>
      <span style={{ fontSize: bold ? 13.5 : 12.5, color: bold ? '#15281d' : '#7c8a82', fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: bold ? 15 : 13, fontWeight: bold ? 700 : 500 }}>{value}</span>
    </div>
  )
}
function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 11 }}>
      <div style={{ fontSize: 11.5, color: '#5d6b63', marginBottom: 5, fontWeight: 500 }}>{label}</div>
      {children}
    </label>
  )
}

const twoCol = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }
const inp = { width: '100%', border: '1px solid #dde2dd', background: '#fff', borderRadius: 9, padding: '9px 11px', fontSize: 15, outline: 'none', boxSizing: 'border-box' }
const empty = { padding: '22px 14px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }
const errorBox = { marginBottom: 14, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }
const ghostBtn = { background: '#fff', color: '#5d6b63', border: '1px solid #e6eae6', borderRadius: 9, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }
const modal = { maxWidth: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }
const cancelBtn = { flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primaryBtn = { flex: 1, background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
