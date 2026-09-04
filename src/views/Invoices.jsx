import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import { loadCustomers, createClient } from '../lib/customersData.js'
import { supabase } from '../lib/supabaseClient.js'
import { paymentsStatus, chargeInvoice, scheduleInvoiceSend, listScheduledSends, cancelScheduledSend } from '../lib/paymentsData.js'
import { loadSettings } from '../lib/settingsData.js'
import { loadRunner, tokenizeCard } from '../lib/runnerJs.js'
import { RichText, RichTextEditor } from '../components/RichText.jsx'
import {
  loadInvoices,
  createInvoice,
  updateInvoice,
  markPaid,
  deleteInvoice,
  textInvoice,
  emailInvoice,
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
const blankLine = () => ({ title: '', description: '', quantity: 1, unitPrice: '' })
const blankForm = () => ({ customerId: '', issueDate: today(), dueDate: '', notes: '', discount: '', items: [blankLine()] })
const blankClient = () => ({ name: '', contactName: '', email: '', phone: '', address: '' })

export default function Invoices({ app }) {
  const isMobile = app.isMobile
  const [invoices, setInvoices] = useState([])
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [notice, setNotice] = useState(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [datePreset, setDatePreset] = useState('all') // all | thisMonth | lastMonth | thisYear | custom
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selId, setSelId] = useState(null)
  const [paymentsOk, setPaymentsOk] = useState(false)
  const [payCfg, setPayCfg] = useState(null) // Runner.js config for "Take payment"
  const [takePay, setTakePay] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(blankForm())

  // Inline "add new client" inside the invoice form
  const [addingClient, setAddingClient] = useState(false)
  const [newClient, setNewClient] = useState(blankClient())
  const [savingClient, setSavingClient] = useState(false)

  // (Retired 2026-08-26) the old "tick addresses × weeks" builder is gone —
  // line items now come from the drivers' check-in/out "Add to draft invoice?"
  // prompt (stop-billing fn): one line per completed stop. Staff can still add
  // blank lines by hand below for credits/edge cases.

  const [busy, setBusy] = useState(false) // detail-pane action in flight
  const [settings, setSettings] = useState(null) // logo/terms/contact for the invoice preview
  const [pendingSends, setPendingSends] = useState([]) // future-dated invoice sends for the selected invoice
  const [schedOpen, setSchedOpen] = useState(false)
  const [schedChannel, setSchedChannel] = useState('sms')
  const [schedDate, setSchedDate] = useState('')
  const [schedTime, setSchedTime] = useState('09:00')

  async function refresh() {
    const rows = await loadInvoices(app.activeLine)
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
    loadSettings().then(setSettings).catch(() => {})
    paymentsStatus().then((d) => { setPaymentsOk(!!(d && d.connected)); setPayCfg(d?.runner || null) }).catch(() => {})
    const unsub = subscribeInvoices(() => refresh().catch(() => {}))
    return () => unsub && unsub()
  }, [app.activeLine])

  // Cross-view prefill: "+ New invoice" on a client's record opens the create
  // form already pointed at that client, with a first line pre-filled from
  // their billing (rate / service, captured at click time).
  useEffect(() => {
    const p = app.invoicePrefill
    if (!p || !p.tick) return
    setEditId(null)
    setAddingClient(false)
    setNewClient(blankClient())
    setForm({
      ...blankForm(),
      customerId: p.customerId,
      items: [{
        ...blankLine(),
        description: p.description || '',
        unitPrice: p.amount != null ? String(p.amount) : '',
      }],
    })
    setShowForm(true)
  }, [app.invoicePrefill?.tick])

  // Date filter — paid invoices count by their PAID date, everything else by
  // issue date, so "This month" reads as "collected/billed this month".
  const range = useMemo(() => {
    const now = new Date()
    const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (datePreset === 'thisMonth') return [dstr(new Date(now.getFullYear(), now.getMonth(), 1)), dstr(now)]
    if (datePreset === 'lastMonth') return [dstr(new Date(now.getFullYear(), now.getMonth() - 1, 1)), dstr(new Date(now.getFullYear(), now.getMonth(), 0))]
    if (datePreset === 'thisYear') return [dstr(new Date(now.getFullYear(), 0, 1)), dstr(now)]
    if (datePreset === 'custom') return [dateFrom || '', dateTo || '']
    return ['', '']
  }, [datePreset, dateFrom, dateTo])

  const dateFiltered = useMemo(() => {
    const [from, to] = range
    if (!from && !to) return invoices
    return invoices.filter((i) => {
      const d = (i.status === 'paid' && i.paidAt ? String(i.paidAt) : i.issueDate || i.createdAt || '').slice(0, 10)
      return !!d && (!from || d >= from) && (!to || d <= to)
    })
  }, [invoices, range])

  const list = useMemo(() => {
    let rows = filter === 'all' ? dateFiltered : dateFiltered.filter((i) => i.status === filter)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter((i) =>
      (i.customerName || '').toLowerCase().includes(q) ||
      (i.number || '').toLowerCase().includes(q)
    )
    return rows
  }, [dateFiltered, filter, search])
  const cur = invoices.find((i) => i.id === selId) || null

  const outstanding = round2(dateFiltered.filter((i) => i.status === 'sent').reduce((s, i) => s + i.total, 0))
  const paidTotal = round2(dateFiltered.filter((i) => i.status === 'paid').reduce((s, i) => s + i.total, 0))
  const tipsTotal = round2(dateFiltered.filter((i) => i.status === 'paid').reduce((s, i) => s + (i.tipAmount || 0), 0))
  const tippedCount = dateFiltered.filter((i) => i.status === 'paid' && i.tipAmount > 0).length
  const draftCount = dateFiltered.filter((i) => i.status === 'draft').length

  // ---- form helpers ----
  const setF = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setItem = (idx, patch) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }))
  const addLine = () => setForm((f) => ({ ...f, items: [...f.items, blankLine()] }))
  const removeLine = (idx) => setForm((f) => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, i) => i !== idx) : f.items }))
  const { subtotal, total } = invoiceTotals(form.items, form.discount)

  // Save a brand-new client created inline, then select it for this invoice.
  async function saveNewClient() {
    const name = newClient.name.trim()
    if (!name) { setErr('Give the new client a name.'); return }
    setSavingClient(true)
    setErr(null)
    try {
      const id = await createClient({
        name,
        contactName: newClient.contactName.trim(),
        email: newClient.email.trim(),
        phone: newClient.phone.trim(),
        address: newClient.address.trim(),
      })
      const rows = await loadCustomers()
      setCustomers(rows)
      setF({ customerId: id })
      setAddingClient(false)
      setNewClient(blankClient())
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setSavingClient(false)
    }
  }
  function cancelNewClient() {
    setAddingClient(false)
    setNewClient(blankClient())
  }

  function openCreate() {
    setEditId(null)
    setAddingClient(false)
    setNewClient(blankClient())
    setForm({ ...blankForm(), customerId: customers[0]?.id || '' })
    setShowForm(true)
  }
  function openEdit(inv) {
    setEditId(inv.id)
    setAddingClient(false)
    setNewClient(blankClient())
    setForm({
      customerId: inv.customerId,
      issueDate: inv.issueDate || today(),
      dueDate: inv.dueDate || '',
      notes: inv.notes || '',
      discount: inv.discount ? String(inv.discount) : '',
      items: inv.items.length ? inv.items.map((it) => ({ title: it.title || '', description: it.description, quantity: it.quantity, unitPrice: it.unitPrice })) : [blankLine()],
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
  const onSendSms = () => action(async () => { await textInvoice(cur) })
  const onSendEmail = () => action(async () => { await emailInvoice(cur) })
  const onSendBoth = () => action(async () => {
    const errs = []
    try { await textInvoice(cur) } catch (e) { errs.push(`text: ${e.message || e}`) }
    try { await emailInvoice(cur) } catch (e) { errs.push(`email: ${e.message || e}`) }
    if (errs.length === 2) throw new Error(errs.join(' · '))
    if (errs.length) setErr(`Sent, but the ${errs[0]}`)
  })

  async function refreshSends(invoiceId) {
    if (!invoiceId) { setPendingSends([]); return }
    try {
      const d = await listScheduledSends(invoiceId)
      setPendingSends(d?.scheduled || [])
    } catch (_e) { setPendingSends([]) }
  }
  useEffect(() => { refreshSends(cur?.id) }, [cur?.id])

  // Interpret the picked date+time as an America/New_York wall clock and
  // return the matching UTC instant (handles EST/EDT via two-pass Intl).
  function etToUtcInstant(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split('-').map(Number)
    const [hh, mi] = timeStr.split(':').map(Number)
    const target = Date.UTC(y, mo - 1, d, hh, mi) // wall clock treated as UTC
    let ts = target
    for (let i = 0; i < 3; i++) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts))
      const g = Object.fromEntries(parts.map((p) => [p.type, p.value]))
      const wallAsUtc = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour === '24' ? 0 : g.hour), Number(g.minute))
      const shift = target - wallAsUtc
      if (shift === 0) break
      ts += shift
    }
    return new Date(ts)
  }

  function openSchedule() {
    const d = new Date(Date.now() + 24 * 3600 * 1000)
    setSchedDate(d.toISOString().slice(0, 10))
    setSchedTime('09:00')
    setSchedChannel(cur?.customerPhone ? (cur?.customerEmail ? 'both' : 'sms') : 'email')
    setSchedOpen(true)
  }

  async function submitSchedule() {
    if (!schedDate || !schedTime) { setErr('Pick a date and time for the scheduled send.'); return }
    const when = etToUtcInstant(schedDate, schedTime)
    setBusy(true); setErr(null)
    try {
      await scheduleInvoiceSend(cur.id, schedChannel, when.toISOString())
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(when)
      setErr(null)
      setNotice(`🗓 Scheduled for ${fmt} ET — we'll ${schedChannel === 'both' ? 'text and email' : schedChannel === 'sms' ? 'text' : 'email'} ${cur.customerName || 'the client'} then.`)
      setSchedOpen(false)
      await refreshSends(cur.id)
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const onCancelSend = (id) => action(async () => {
    await cancelScheduledSend(id)
    await refreshSends(cur.id)
  })
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
      {/* summary — all cards follow the date filter above the list */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <SummaryCard label="Outstanding" value={money(outstanding)} sub={`${dateFiltered.filter((i) => i.status === 'sent').length} sent`} accent="#b07a1e" />
        <SummaryCard label="Collected" value={money(paidTotal)} sub={`${dateFiltered.filter((i) => i.status === 'paid').length} paid`} accent="#1f7a4d" />
        <SummaryCard label="Tips collected 🎁" value={money(tipsTotal)} sub={tippedCount ? `${tippedCount} tipped` : 'no tips yet'} accent="#6b4fa0" />
        <SummaryCard label="Drafts" value={String(draftCount)} sub="not sent yet" accent="#7c8a82" />
        <div style={{ flex: 1 }} />
        <button onClick={openCreate} style={{ alignSelf: 'center', background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 17px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>+ New invoice</button>
      </div>

      {err && <div style={errorBox}>{err}</div>}
      {notice && (
        <div style={{ marginBottom: 14, background: '#eef7f1', border: '1px solid #cfe7da', color: '#1f7a4d', borderRadius: 11, padding: '9px 13px', fontSize: 12.5, display: 'flex', gap: 8 }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button onClick={() => setNotice(null)} style={{ background: 'none', border: 'none', color: '#1f7a4d', fontSize: 15, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>
      )}
      {!paymentsOk && !loading && (
        <div style={{ marginBottom: 14, background: '#fff7e9', border: '1px solid #f0dcb0', color: '#8a6320', borderRadius: 11, padding: '9px 13px', fontSize: 12.5 }}>
          Run Merchant isn’t connected yet — you can still create and edit invoices, but “Send” needs Run Merchant set up in Settings → Payments.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '0.85fr 1.15fr', gap: 18 }}>
        {/* list */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 8 }}>
          <div style={{ position: 'relative', padding: '4px 4px 8px' }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by client or invoice #…"
              style={{ ...inp, fontSize: 13, padding: '8px 30px 8px 11px' }}
            />
            {search && (
              <button onClick={() => setSearch('')} title="Clear search" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9aa69e', fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 5, padding: '4px 4px 8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {FILTERS.map(([id, label]) => {
              const on = filter === id
              const n = id === 'all' ? dateFiltered.length : dateFiltered.filter((i) => i.status === id).length
              return (
                <button key={id} onClick={() => setFilter(id)} style={{ background: on ? '#1f7a4d' : '#f3f5f2', color: on ? '#fff' : '#5d6b63', border: 'none', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{label} {n ? `· ${n}` : ''}</button>
              )
            })}
            <span style={{ flex: 1 }} />
            <select
              value={datePreset}
              onChange={(e) => setDatePreset(e.target.value)}
              style={{ ...inp, width: 'auto', fontSize: 12, fontWeight: 600, padding: '6px 8px', color: datePreset === 'all' ? '#5d6b63' : '#1f7a4d', background: datePreset === 'all' ? '#f3f5f2' : '#e7f1eb', cursor: 'pointer' }}
            >
              <option value="all">All dates</option>
              <option value="thisMonth">This month</option>
              <option value="lastMonth">Last month</option>
              <option value="thisYear">This year</option>
              <option value="custom">Custom range…</option>
            </select>
            {datePreset === 'custom' && (
              <>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...inp, width: 132, fontSize: 12, padding: '6px 8px', color: '#5d6b63' }} />
                <span style={{ color: '#9aa69e', fontSize: 11 }}>to</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...inp, width: 132, fontSize: 12, padding: '6px 8px', color: '#5d6b63' }} />
              </>
            )}
          </div>

          {loading && <div style={empty}>Loading invoices…</div>}
          {!loading && !invoices.length && <div style={empty}>No invoices yet. Create your first with “New invoice”.</div>}
          {!loading && !!invoices.length && !list.length && <div style={empty}>{search.trim() ? `No invoices match “${search.trim()}”.` : datePreset !== 'all' ? 'No invoices in this date range.' : `No ${filter} invoices.`}</div>}

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
                  <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>
                    {money(inv.total)}
                    {inv.tipAmount > 0 && <span style={{ color: '#1f7a4d', fontSize: 11 }}> +{money(inv.tipAmount)}🎁</span>}
                  </div>
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
          {cur && <InvoiceDetail inv={cur} settings={settings} paymentsOk={paymentsOk} busy={busy} onEdit={() => openEdit(cur)} onMarkPaid={onMarkPaid} onSendSms={onSendSms} onSendEmail={onSendEmail} onSendBoth={onSendBoth} onSchedule={openSchedule} pendingSends={pendingSends} onCancelSend={onCancelSend} onDelete={onDelete} onTakePayment={payCfg ? () => setTakePay(true) : null} />}
        </div>
      </div>

      {takePay && cur && (
        <TakePaymentModal inv={cur} cfg={payCfg} onClose={() => setTakePay(false)} onPaid={() => refresh().catch(() => {})} />
      )}

      {schedOpen && cur && (
        <div onClick={() => !busy && setSchedOpen(false)} style={overlay}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 420 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>🗓 Send in the future</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 16 }}>Invoice {cur.number} · {cur.customerName}</div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {[['sms', '📱 SMS'], ['email', '✉️ Email'], ['both', '📲 Both']].map(([val, label]) => (
                <button key={val} type="button" onClick={() => setSchedChannel(val)} style={{ flex: 1, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, padding: '8px 6px', borderRadius: 8, border: `1px solid ${schedChannel === val ? '#1f7a4d' : '#dde2dd'}`, background: schedChannel === val ? '#e7f1eb' : '#fff', color: schedChannel === val ? '#1f7a4d' : '#7c8a82' }}>{label}</button>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 6 }}>
              <label style={{ fontSize: 11.5, color: '#5d6b63', fontWeight: 600 }}>
                Date
                <input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} style={{ ...inp, marginTop: 4 }} />
              </label>
              <label style={{ fontSize: 11.5, color: '#5d6b63', fontWeight: 600 }}>
                Time (Eastern)
                <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} style={{ ...inp, marginTop: 4 }} />
              </label>
            </div>
            <div style={{ fontSize: 11.5, color: '#9aa69e', marginBottom: 16 }}>Times are Eastern ({Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/New_York' ? 'your local time' : 'converted from your local clock automatically'}). Sends go out within ~5 minutes of the scheduled time.</div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setSchedOpen(false)} style={ghostBtn}>Cancel</button>
              <button type="button" onClick={submitSchedule} disabled={busy || !schedDate || !schedTime} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy || !schedDate || !schedTime ? 0.6 : 1 }}>{busy ? 'Scheduling…' : 'Schedule send'}</button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div onClick={() => !saving && setShowForm(false)} style={overlay}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ ...modal, width: 620 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{editId ? 'Edit invoice' : 'New invoice'}</div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 16 }}>Add line items — the total updates as you type.</div>

            <div style={twoCol}>
              <Field label="Customer *">
                <CustomerSelect
                  customers={customers}
                  value={form.customerId}
                  disabled={!!editId}
                  onChange={(id) => setF({ customerId: id })}
                  onAddNew={(name) => { setNewClient((c) => ({ ...blankClient(), name: name || '' })); setAddingClient(true) }}
                />
              </Field>
              <div style={twoCol}>
                <Field label="Issue date"><input value={form.issueDate || ''} onChange={(e) => setF({ issueDate: e.target.value })} style={inp} type="date" /></Field>
                <Field label="Due date"><input value={form.dueDate || ''} onChange={(e) => setF({ dueDate: e.target.value })} style={inp} type="date" /></Field>
                </div>
              </div>

              {(() => {
                const c = customers.find((x) => x.id === form.customerId)
                if (!c) return null
                return (
                  <div style={{ background: '#f7f9f7', border: '1px solid #e6eae6', borderRadius: 11, padding: '10px 14px', marginBottom: 12 }}>
                    <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 4 }}>BILL TO</div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                    {(c.email || c.phone || c.address) && (
                      <div style={{ fontSize: 12, color: '#7c8a82', marginTop: 2 }}>
                        {[c.email, c.phone, c.address].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {!c.email && !c.phone && <div style={{ fontSize: 11.5, color: '#c08a2e', marginTop: 3 }}>No email or phone on file — add them on the client record so the invoice shows contact info.</div>}
                  </div>
                )
              })()}

            {addingClient && (
              <div style={{ background: '#f7f9f7', border: '1px solid #e6eae6', borderRadius: 11, padding: 14, marginBottom: 4 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>New client</div>
                <div style={twoCol}>
                  <Field label="Name *"><input value={newClient.name} onChange={(e) => setNewClient((c) => ({ ...c, name: e.target.value }))} style={inp} placeholder="Business or person" autoFocus /></Field>
                  <Field label="Contact name"><input value={newClient.contactName} onChange={(e) => setNewClient((c) => ({ ...c, contactName: e.target.value }))} style={inp} placeholder="Optional" /></Field>
                </div>
                <div style={twoCol}>
                  <Field label="Email"><input value={newClient.email} onChange={(e) => setNewClient((c) => ({ ...c, email: e.target.value }))} style={inp} type="email" placeholder="Optional" /></Field>
                  <Field label="Phone"><input value={newClient.phone} onChange={(e) => setNewClient((c) => ({ ...c, phone: e.target.value }))} style={inp} placeholder="Optional" /></Field>
                </div>
                <Field label="Address"><input value={newClient.address} onChange={(e) => setNewClient((c) => ({ ...c, address: e.target.value }))} style={inp} placeholder="Optional" /></Field>
                <div style={{ display: 'flex', gap: 9, marginTop: 4 }}>
                  <button type="button" onClick={cancelNewClient} disabled={savingClient} style={cancelBtn}>Cancel</button>
                  <button type="button" onClick={saveNewClient} disabled={savingClient || !newClient.name.trim()} style={{ ...primaryBtn, opacity: savingClient || !newClient.name.trim() ? 0.6 : 1 }}>{savingClient ? 'Saving…' : 'Save client'}</button>
                </div>
              </div>
            )}

            <div style={{ fontSize: 11.5, color: '#9aa69e', margin: '4px 0 0' }}>
              Service lines are added automatically when drivers complete stops (check-in/out → "Add to draft invoice"). Add blank lines by hand below only for credits or one-off adjustments.
            </div>

            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', margin: '8px 0 8px', paddingTop: 10, borderTop: '1px solid #eef0ed' }}>LINE ITEMS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {form.items.map((it, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 80px 64px 24px', gap: 7, alignItems: 'start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <input value={it.title || ''} onChange={(e) => setItem(idx, { title: e.target.value })} style={{ ...inp, fontSize: 13, fontWeight: 600 }} placeholder="Title — e.g. Weekly valet trash" />
                    <RichTextEditor
                      value={it.description}
                      onChange={(v) => setItem(idx, { description: v })}
                      placeholder="Description — B, I, U, bullets supported"
                      rows={2}
                    />
                  </div>
                  <input value={it.quantity} onChange={(e) => setItem(idx, { quantity: e.target.value })} style={{ ...inp, fontSize: 13, textAlign: 'center' }} type="number" step="any" placeholder="Qty" />
                  <input value={it.unitPrice} onChange={(e) => setItem(idx, { unitPrice: e.target.value })} style={{ ...inp, fontSize: 13, textAlign: 'right' }} type="number" step="0.01" placeholder="Price" />
                  <div style={{ fontFamily: MONO, fontSize: 12.5, textAlign: 'right', color: '#5d6b63', paddingTop: 66 }}>{money(lineAmount(it))}</div>
                  <button type="button" onClick={() => removeLine(idx)} style={{ background: 'none', border: 'none', color: '#c0492f', fontSize: 16, cursor: 'pointer', padding: 0, paddingTop: 8 }} title="Remove line">×</button>
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

// Service photos for the invoice's stops, grouped by stop (address + date).
// Fetched render-time from stop_photos so late-added photos show up too.
function StopPhotos({ stopIds }) {
  const [groups, setGroups] = useState([])
  useEffect(() => {
    let alive = true
    if (!stopIds.length) { setGroups([]); return }
    ;(async () => {
      try {
        const { data: stops } = await supabase
          .from('route_stops')
          .select('id, properties(address), routes(service_date)')
          .in('id', stopIds)
        const { data: photos } = await supabase
          .from('stop_photos')
          .select('stop_id, path')
          .in('stop_id', stopIds)
          .order('created_at', { ascending: true })
        if (!alive) return
        const byStop = new Map((stops || []).map((s) => {
          const d = s.routes?.service_date ? String(s.routes.service_date).slice(0, 10) : null
          return [s.id, { heading: [s.properties?.address, d].filter(Boolean).join(' — ') || 'Service photos', urls: [] }]
        }))
        for (const p of photos || []) {
          const g = byStop.get(p.stop_id)
          if (g) g.urls.push(supabase.storage.from('stop-photos').getPublicUrl(p.path).data.publicUrl)
        }
        setGroups([...byStop.values()].filter((g) => g.urls.length))
      } catch (_e) { if (alive) setGroups([]) }
    })()
    return () => { alive = false }
  }, [stopIds.join(',')])
  if (!groups.length) return null
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#9aa69e', margin: '10px 0 8px' }}>SERVICE PHOTOS</div>
      {groups.map((g, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1a2420', marginBottom: 6 }}>{g.heading}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7 }}>
            {g.urls.map((u, j) => (
              <a key={j} href={u} target="_blank" rel="noreferrer">
                <img src={u} alt={g.heading} style={{ width: '100%', borderRadius: 8, border: '1px solid #e6eae6', display: 'block' }} />
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function InvoiceDetail({ inv, settings, paymentsOk, busy, onEdit, onMarkPaid, onSendSms, onSendEmail, onSendBoth, onSchedule, pendingSends, onCancelSend, onDelete, onTakePayment }) {
  const meta = STATUS_META[inv.status] || STATUS_META.draft
  const company = settings || {}
  const contactBits = [company.company_phone, company.company_email, company.company_address].filter(Boolean)
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
      {/* masthead: logo + business name (left) · contact info (right) */}
      <div style={{ padding: '22px 22px 16px', display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 200 }}>
          {company.logo_url ? (
            <img src={company.logo_url} alt="logo" style={{ width: 52, height: 52, borderRadius: 11, objectFit: 'cover', border: '1px solid #e6eae6' }} />
          ) : (
            <div style={{ width: 52, height: 52, borderRadius: 11, background: '#1f7a4d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 22 }}>
              {(company.company_name || 'V')[0]}
            </div>
          )}
          <div style={{ fontWeight: 800, fontSize: 17 }}>{company.company_name || 'Valet Waste FL'}</div>
        </div>
        {contactBits.length > 0 && (
          <div style={{ textAlign: 'right', fontSize: 12, color: '#5d6b63', lineHeight: 1.6 }}>
            {company.company_phone && <div>{company.company_phone}</div>}
            {company.company_email && <div>{company.company_email}</div>}
            {company.company_address && <div>{company.company_address}</div>}
          </div>
        )}
        <span style={{ flex: 'none', fontFamily: MONO, fontSize: 11, color: meta.color, background: meta.bg, padding: '4px 11px', borderRadius: 7, fontWeight: 600 }}>{meta.label.toUpperCase()}</span>
      </div>
      <div style={{ height: 4, background: 'linear-gradient(90deg, #1f7a4d, #2ea56b)' }} />

      {/* title + number + bill-to */}
      <div style={{ display: 'flex', gap: 22, padding: '16px 22px 4px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '.04em', color: '#15281d' }}>INVOICE</div>
          <div style={{ fontFamily: MONO, fontSize: 13, color: '#5d6b63', marginTop: 2 }}>{inv.number}</div>
          <div style={{ fontSize: 12, color: '#9aa69e', marginTop: 6 }}>
            Issued {fmtDate(inv.issueDate)}{inv.dueDate ? ` · Due ${fmtDate(inv.dueDate)}` : ''}{inv.paidAt ? ` · Paid ${new Date(inv.paidAt).toLocaleDateString()}` : ''}
          </div>
        </div>
        <div style={{ minWidth: 200 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.1em', color: '#9aa69e', marginBottom: 4 }}>BILL TO</div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{inv.customerName || 'Unknown customer'}</div>
          {inv.customerEmail && <div style={{ fontSize: 12.5, color: '#5d6b63', marginTop: 2 }}>{inv.customerEmail}</div>}
          {inv.customerPhone && <div style={{ fontSize: 12.5, color: '#5d6b63', marginTop: 2 }}>{inv.customerPhone}</div>}
          {inv.customerAddress && <div style={{ fontSize: 12.5, color: '#5d6b63', marginTop: 2 }}>{inv.customerAddress}</div>}
        </div>
      </div>

      {/* line items */}
      <div style={{ padding: '14px 22px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 50px 90px 90px', gap: 8, padding: '8px 10px', fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#fff', background: '#1f7a4d', borderRadius: 8 }}>
          <div>DESCRIPTION</div><div style={{ textAlign: 'center' }}>QTY</div><div style={{ textAlign: 'right' }}>PRICE</div><div style={{ textAlign: 'right' }}>AMOUNT</div>
        </div>
        {inv.items.length === 0 && <div style={{ padding: '12px 0', color: '#9aa69e', fontSize: 12.5 }}>No line items.</div>}
        {inv.items.map((it) => (
          <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1fr 50px 90px 90px', gap: 8, padding: '9px 10px', borderBottom: '1px solid #f5f6f4', fontSize: 13, alignItems: 'start' }}>
            <div style={{ color: '#1a2420' }}>
              {it.title ? <div style={{ fontWeight: 700, fontSize: 13, color: '#1a2420', marginBottom: 2 }}>{it.title}</div> : null}
              {it.description ? <RichText text={it.description} style={{ fontSize: 13, color: '#1a2420' }} /> : (it.title ? null : '—')}
            </div>
            <div style={{ textAlign: 'center', fontFamily: MONO, color: '#5d6b63', paddingTop: 2 }}>{it.quantity}</div>
            <div style={{ textAlign: 'right', fontFamily: MONO, color: '#5d6b63', paddingTop: 2 }}>{money(it.unitPrice)}</div>
            <div style={{ textAlign: 'right', fontFamily: MONO, paddingTop: 2 }}>{money(it.amount)}</div>
          </div>
        ))}

        {/* totals */}
        <div style={{ marginLeft: 'auto', width: 220, marginTop: 12 }}>
          <TotalRow label="Subtotal" value={money(inv.subtotal)} />
          {inv.discount > 0 && <TotalRow label="Discount" value={'– ' + money(inv.discount)} />}
          {inv.tipAmount > 0 && <TotalRow label="Tip" value={'+ ' + money(inv.tipAmount)} />}
          <div style={{ height: 1, background: '#e6eae6', margin: '8px 0' }} />
          <TotalRow label={inv.tipAmount > 0 ? 'Invoice total' : 'Total'} value={money(inv.total)} bold />
          {inv.tipAmount > 0 && <TotalRow label="Charged (with tip)" value={money(inv.total + inv.tipAmount)} bold />}
        </div>
        {/* service photos — grouped by stop (render-time, same as the email + pay page) */}
        <StopPhotos stopIds={(inv.items || []).map((it) => it.stopId).filter(Boolean)} />

      </div>

      {(inv.notes || company.invoice_terms) && (
        <div style={{ padding: '4px 22px 14px' }}>
          {inv.notes && (
            <>
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#9aa69e', margin: '10px 0 5px' }}>NOTES</div>
              <RichText text={inv.notes} style={{ fontSize: 12.5, color: '#5d6b63' }} />
            </>
          )}
          {company.invoice_terms && (
            <>
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#9aa69e', margin: '12px 0 5px' }}>TERMS &amp; CONDITIONS</div>
              <RichText text={company.invoice_terms} style={{ fontSize: 11.5, color: '#7c8a82' }} />
            </>
          )}
        </div>
      )}

      {/* pay link */}
      {inv.paymentUrl && (
        <div style={{ margin: '0 22px 14px', display: 'flex', gap: 8, alignItems: 'center', background: '#eef7f1', border: '1px solid #cfe7da', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: '#1f7a4d', fontWeight: 600 }}>Payment link</div>
            <input readOnly value={inv.paymentUrl} onFocus={(e) => e.target.select()} style={{ width: '100%', border: '1px solid #cfe7da', background: '#fff', borderRadius: 7, padding: '6px 9px', fontSize: 11.5, marginTop: 5, boxSizing: 'border-box' }} />
          </div>
          <a href={inv.paymentUrl} target="_blank" rel="noreferrer" style={{ flex: 'none', background: '#1f7a4d', color: '#fff', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>Open</a>
        </div>
      )}

      {/* scheduled sends */}
      {pendingSends.length > 0 && (
        <div style={{ margin: '0 22px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pendingSends.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f5f0e4', border: '1px solid #e7dcc2', borderRadius: 10, padding: '8px 12px', fontSize: 12.5 }}>
              <span>🗓</span>
              <div style={{ flex: 1, color: '#8a6320' }}>
                Scheduled for <b>{new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s.send_at))} ET</b> · {s.channel === 'both' ? 'text + email' : s.channel === 'sms' ? 'text' : 'email'}
              </div>
              <button onClick={() => onCancelSend(s.id)} disabled={busy} style={{ background: 'none', border: 'none', color: '#c0492f', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            </div>
          ))}
        </div>
      )}

      {/* actions */}
      <div style={{ display: 'flex', gap: 9, padding: '14px 22px', borderTop: '1px solid #f0f2ef', flexWrap: 'wrap' }}>
        {inv.status === 'draft' && <button onClick={onEdit} disabled={busy} style={ghostBtn}>Edit</button>}
        {inv.status !== 'paid' && paymentsOk && (
          <SendMenu
            busy={busy}
            hasPhone={!!inv.customerPhone}
            hasEmail={!!inv.customerEmail}
            onSms={onSendSms}
            onEmail={onSendEmail}
            onBoth={onSendBoth}
          />
        )}
        {inv.status !== 'paid' && inv.status !== 'void' && (
          <button onClick={onSchedule} disabled={busy} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>🗓 Send in the future…</button>
        )}
        {inv.status !== 'paid' && inv.status !== 'void' && onTakePayment && (
          <button onClick={onTakePayment} disabled={busy} style={{ background: '#fff', border: '1px solid #cfe0d5', color: '#1f7a4d', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>💳 Take payment</button>
        )}
        {inv.status !== 'paid' && <button onClick={onMarkPaid} disabled={busy} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>Mark paid</button>}
        <div style={{ flex: 1 }} />
        <button onClick={onDelete} disabled={busy} style={{ background: '#fff', border: '1px solid #f0c9c2', color: '#c0492f', borderRadius: 9, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
      </div>
    </div>
  )
}

// "Send ▾" split button: paper-plane Send with a dropdown for SMS / email /
// both. Closes on outside click or Esc.
function SendMenu({ busy, hasPhone, hasEmail, onSms, onEmail, onBoth }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const item = (label, icon, enabled, onClick, hint) => (
    <button
      key={label}
      disabled={!enabled || busy}
      title={enabled ? '' : hint}
      onClick={() => { setOpen(false); onClick() }}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', textAlign: 'left', padding: '9px 12px', fontSize: 13, fontWeight: 600, color: enabled ? '#1a2420' : '#b6c0ba', cursor: enabled && !busy ? 'pointer' : 'not-allowed' }}
    >
      <span style={{ width: 18, textAlign: 'center' }}>{icon}</span>{label}
    </button>
  )

  return (
    <div ref={ref} style={{ position: 'relative', flex: 'none' }}>
      <button onClick={() => setOpen((o) => !o)} disabled={busy} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
        {busy ? 'Working…' : 'Send'} <span style={{ fontSize: 10, opacity: 0.85 }}>▾</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30, minWidth: 190, background: '#fff', border: '1px solid #e0e7e2', borderRadius: 10, boxShadow: '0 8px 24px rgba(26,36,32,.12)', padding: 5, display: 'flex', flexDirection: 'column' }}>
          {item('Send SMS', '📱', hasPhone, onSms, 'No phone number on file for this customer')}
          {item('Send Email', '✉️', hasEmail, onEmail, 'No email on file for this customer')}
          {item('Send Both', '📲', hasPhone && hasEmail, onBoth, 'Needs both a phone number and an email on file')}
        </div>
      )}
    </div>
  )
}

// Searchable customer picker used in the invoice form. Type to filter; the
// "+ Add new client…" row stays pinned at the top.
function CustomerSelect({ customers, value, onChange, onAddNew, disabled }) {
  const selected = customers.find((c) => c.id === value) || null
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef(null)

  useEffect(() => {
    function onDoc(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  if (disabled) {
    return <input value={selected?.name || ''} readOnly style={{ ...inp, background: '#f3f5f2', color: '#5d6b63' }} />
  }

  const q = query.trim().toLowerCase()
  const filtered = q ? customers.filter((c) => (c.name || '').toLowerCase().includes(q)) : customers
  // Typed a name nobody in the system matches → offer to add them. Exact
  // (case-insensitive) matches mean they're already in the system.
  const exact = q && customers.some((c) => (c.name || '').toLowerCase() === q)
  const typed = query.trim()

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        value={open ? query : (selected?.name || '')}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { setOpen(true); setQuery('') }}
        placeholder={selected ? selected.name : 'Search or type a new name…'}
        style={inp}
      />
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: '#fff', border: '1px solid #dde2dd', borderRadius: 9, boxShadow: '0 12px 32px rgba(0,0,0,.14)', zIndex: 20, maxHeight: 240, overflowY: 'auto', padding: 4 }}>
          {typed && !exact && (
            <div
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); setQuery(''); onAddNew(typed) }}
              style={{ padding: '8px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#1f7a4d', background: '#f3faf5' }}
            >
              {filtered.length ? 'Not them? ' : ''}Add “{typed}” as a new client…
            </div>
          )}
          <div
            onMouseDown={(e) => { e.preventDefault(); setOpen(false); setQuery(''); onAddNew('') }}
            style={{ padding: '8px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#5d6b63' }}
          >+ Add a different new client…</div>
          {filtered.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12.5, color: '#9aa69e' }}>No clients match — add them above.</div>}
          {filtered.map((c) => (
            <div
              key={c.id}
              onMouseDown={(e) => { e.preventDefault(); onChange(c.id); setQuery(''); setOpen(false) }}
              style={{ padding: '8px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 13, background: c.id === value ? '#f3faf5' : 'transparent' }}
            >{c.name}</div>
          ))}
        </div>
      )}
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

// ---- Take payment modal ------------------------------------------------------
// Staff-side charge: key in the customer's card (Runner.js iframe — the PAN
// never touches our code) or charge their saved card on file in one click.
// Uses the same `payments` fn charge_invoice as the customer pay page, so the
// invoice is marked paid on approval.
function TakePaymentModal({ inv, cfg, onClose, onPaid }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const [runnerReady, setRunnerReady] = useState(false)
  const [formKey, setFormKey] = useState(0) // bump = remount the Runner form
  const runnerRef = useRef(null)

  useEffect(() => {
    if (!cfg?.public_key) return
    let cancelled = false
    loadRunner().then((Runner) => {
      if (cancelled) return
      const r = new Runner()
      r.init({
        element: '#run-take-form',
        publicKey: cfg.public_key,
        mid: cfg.mid,
        env: cfg.env === 'uat' ? 'staging' : 'production',
        useExpiry: true,
        useCvv: true,
      })
      runnerRef.current = r
      setRunnerReady(true)
    }).catch((e) => setErr(e.message || String(e)))
    return () => { cancelled = true; runnerRef.current = null }
  }, [cfg?.public_key, cfg?.mid, cfg?.env, formKey])

  // Runner's fields are single-use (a tokenize consumes them even when the
  // charge fails) — remount the container to recover; there's no reset() API.
  function resetCardForm() {
    runnerRef.current = null
    setRunnerReady(false)
    setFormKey((k) => k + 1)
  }

  function finish(res) {
    if (res && res.ok) {
      setDone(true)
      onPaid && onPaid()
    } else if (res && res.declined) {
      resetCardForm()
      setErr(res.resp_text || 'The card was declined — re-enter the card details and try again.')
    } else {
      resetCardForm()
      setErr((res && res.error) || 'Payment could not be completed.')
    }
  }

  async function chargeSaved() {
    if (!window.confirm(`Charge ${inv.customerName}'s saved ${String(inv.savedCard?.brand || 'card').toUpperCase()} ••${inv.savedCard?.last4} for ${money(inv.total)}?`)) return
    setBusy(true)
    setErr('')
    try {
      finish(await chargeInvoice({ invoiceId: inv.id, useSaved: true }))
    } catch (e) { setErr(e.message || String(e)) }
    setBusy(false)
  }

  async function chargeKeyed() {
    if (!runnerRef.current) return
    setBusy(true)
    setErr('')
    try {
      const t = await tokenizeCard(runnerRef.current)
      if (!t || (!t.account_token && !t.token)) {
        console.warn('[take-payment] empty tokenize response:', t)
        resetCardForm()
        setErr("Couldn't read the card details — please re-enter them and try again.")
        setBusy(false)
        return
      }
      finish(await chargeInvoice({
        invoiceId: inv.id,
        accountToken: t.account_token || t.token,
        expiration: t.expiry,
        cvn: t.cvn || t.cvv,
        name: inv.customerName,
      }))
    } catch (e) {
      setErr(e.message || String(e))
      resetCardForm()
    }
    setBusy(false)
  }

  return (
    <div onClick={() => !busy && onClose()} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 440 }}>
        {done ? (
          <div style={{ textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: 30 }}>✓</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#1f7a4d', marginTop: 6 }}>Payment received</div>
            <div style={{ fontSize: 13, color: '#5d6b63', marginTop: 6 }}>Invoice {inv.number} is paid — {money(inv.total)}.</div>
            <button onClick={onClose} style={{ ...primaryBtn, flex: 'none', marginTop: 16, padding: '10px 22px' }}>Done</button>
          </div>
        ) : (
          <>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Take payment</div>
            <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 14 }}>
              Invoice {inv.number} · {inv.customerName} · <b style={{ color: '#1a2420' }}>{money(inv.total)}</b>
            </div>
            {err && <div style={{ ...errorBox, marginBottom: 12 }}>{err}</div>}

            {inv.savedCard && (
              <>
                <button onClick={chargeSaved} disabled={busy} style={{ ...primaryBtn, width: '100%', padding: '12px 16px', opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'Working…' : `Charge saved ${String(inv.savedCard.brand).toUpperCase()} ••${inv.savedCard.last4} — ${money(inv.total)}`}
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
                  <div style={{ flex: 1, height: 1, background: '#e6eae6' }} />
                  <span style={{ fontSize: 11.5, color: '#9aa69e' }}>or enter a card</span>
                  <div style={{ flex: 1, height: 1, background: '#e6eae6' }} />
                </div>
              </>
            )}

            {/* Runner.js owns #run-take-form's children — keep React out of it
                (rendering inside breaks reconciliation → removeChild crash). */}
            <div key={formKey} id="run-take-form" style={{ minHeight: 64, marginBottom: 6 }} />
            {!runnerReady && <div style={{ color: '#9aa69e', fontSize: 12.5, padding: '0 2px 8px' }}>Loading secure card form…</div>}
            <div style={{ display: 'flex', gap: 9, marginTop: 10 }}>
              <button onClick={onClose} disabled={busy} style={cancelBtn}>Cancel</button>
              <button onClick={chargeKeyed} disabled={busy || !runnerReady} style={{ ...primaryBtn, opacity: (busy || !runnerReady) ? 0.6 : 1 }}>
                {busy ? 'Processing…' : `Charge ${money(inv.total)}`}
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#9aa69e', marginTop: 10 }}>
              Card details are entered in a secure Run Payments field — they never touch this app's code or database.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
