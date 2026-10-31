// Billing run — the third billing-board tab (Invoices | Billing run |
// Estimates). One big list of every open invoice (drafts that drivers' stops
// are still adding lines to, plus unsent/sent ones), split into two groups:
//
//   • Card on file  → "Run billing" charges each saved card ONE AT A TIME,
//     server-side, and emails the customer a receipt (no invoice email —
//     Randy's "just send the receipt" ask). Declines are recorded and the run
//     moves on; the invoice stays open for follow-up.
//   • No card       → the run sends the invoice instead (email with a Pay Now
//     link, or SMS when there's no email). "Viewed" tracking (viewed_at,
//     stamped when the pay link is first opened) shows who's actually looked.
//
// The run is chunked through the payments fn's billing_run action (edge
// functions have a wall-clock limit); the UI pages the cursor until done and
// shows per-invoice results live. Processing a list twice is safe: the server
// re-checks status before every charge/send and skips anything already paid.
//
// Row interactions:
//   • Click a row → inline invoice preview (lines, totals, service photos).
//     Drafts are editable there (line titles — e.g. adding service dates —
//     qty/price, add/remove lines); sent/paid are read-only (immutable).
//   • Checkboxes → bulk bar: void (reversible) or merge. Merge folds every
//     selected draft's line items AND photos into one target draft and voids
//     the sources (existing mergeInvoiceInto data-layer path).

import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { runBilling } from '../lib/paymentsData.js'
import { logActivity } from '../lib/activityData.js'
import { updateInvoice, mergeInvoiceInto, setInvoiceStatus, loadInvoicePhotos, invoiceTotals } from '../lib/invoicesData.js'

const GREEN = '#1f7a4d'
const money = (v) => '$' + Number(v || 0).toFixed(2)
const fmtViewed = (ts) => {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch { return '' }
}

const chip = (bg, color) => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: bg, color, whiteSpace: 'nowrap' })
const inp = { border: '1px solid #dde2dd', borderRadius: 7, padding: '5px 8px', fontSize: 12.5, outline: 'none', width: '100%', background: '#fff' }
// Drafts only accept stop lines in the month they were created (stop-billing
// filters on created_at >= month start), so "still accumulating" is only true
// for THIS month's drafts — last month's leftover drafts are done and just
// need to be sent/charged.
const isCurrentMonth = (ts) => {
  try { return String(ts).slice(0, 7) === new Date().toISOString().slice(0, 7) } catch { return false }
}
const monthName = (ts) => {
  try { return new Date(String(ts).length === 10 ? ts + 'T12:00:00' : ts).toLocaleDateString(undefined, { month: 'long' }) } catch { return 'prior month' }
}

export default function BillingRun({ invoices, loading, app, onChanged, onOpenInvoice }) {
  const isMobile = app?.isMobile
  const [filter, setFilter] = useState('all') // all | card | noc | viewed | notviewed
  const [search, setSearch] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null) // { total, processed }
  const [results, setResults] = useState({}) // invoice_id → billing_run result row
  const [err, setErr] = useState('')
  const [summary, setSummary] = useState(null) // final run summary {charged, sent, failed, chargedTotal}
  const cancelRef = useRef(false)
  const [expandedId, setExpandedId] = useState(null)
  const [sel, setSel] = useState(() => new Set())
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  // Open invoices only — paid/void never appear here.
  const open = useMemo(
    () => (invoices || []).filter((i) => (i.status === 'draft' || i.status === 'sent') && Number(i.total) > 0),
    [invoices],
  )

  const filtered = useMemo(() => {
    let rows = open
    if (filter === 'card') rows = rows.filter((i) => i.savedCard)
    else if (filter === 'noc') rows = rows.filter((i) => !i.savedCard)
    else if (filter === 'viewed') rows = rows.filter((i) => i.viewedAt)
    else if (filter === 'notviewed') rows = rows.filter((i) => !i.viewedAt)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter((i) => (i.customerName || '').toLowerCase().includes(q) || (i.number || '').toLowerCase().includes(q))
    return rows.slice().sort((a, b) => (b.savedCard ? 1 : 0) - (a.savedCard ? 1 : 0) || String(a.customerName).localeCompare(String(b.customerName)))
  }, [open, filter, search])

  const byId = useMemo(() => Object.fromEntries(open.map((i) => [i.id, i])), [open])
  const selected = useMemo(() => [...sel].map((id) => byId[id]).filter(Boolean), [sel, byId])
  const allDrafts = selected.length > 0 && selected.every((i) => i.status === 'draft')

  function toggleSel(id) {
    setSel((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleSelAll() {
    if (sel.size === filtered.length) setSel(new Set())
    else setSel(new Set(filtered.map((i) => i.id)))
  }

  async function voidSelected() {
    if (!selected.length) return
    if (!window.confirm(`Void ${selected.length} invoice(s)?\n\n${selected.map((i) => `• ${i.number} — ${i.customerName} (${money(i.total)})`).join('\n')}\n\nVoiding is reversible (unlike delete) — the invoice stays in the system but is excluded from billing.`)) return
    setBulkBusy(true)
    setErr('')
    try {
      for (const inv of selected) await setInvoiceStatus(inv.id, 'void')
      logActivity({ type: 'invoice_updated', summary: `Voided ${selected.length} invoice(s) from the Billing run board`, entityType: 'invoice' })
      setSel(new Set())
      onChanged && onChanged()
    } catch (e) { setErr(e.message || String(e)) }
    setBulkBusy(false)
  }

  function openMerge() {
    if (!allDrafts || selected.length < 2) return
    // Default target: the draft with the most lines (usually the month's
    // running invoice everything else folds into).
    const target = selected.slice().sort((a, b) => b.items.length - a.items.length)[0]
    setMergeTargetId(target.id)
    setMergeOpen(true)
  }

  async function doMerge() {
    const target = byId[mergeTargetId]
    const sources = selected.filter((i) => i.id !== mergeTargetId)
    if (!target || !sources.length) return
    if (!window.confirm(
      `Merge ${sources.length} invoice(s) into ${target.number} (${target.customerName})?\n\n` +
      sources.map((s) => `• ${s.number}: ${s.items.length} line(s), ${money(s.total)}`).join('\n') +
      `\n\nAll line items and photos move into ${target.number}; the source invoice(s) are voided.`
    )) return
    setBulkBusy(true)
    setErr('')
    try {
      for (const s of sources) await mergeInvoiceInto(s.id, { targetId: target.id })
      logActivity({ type: 'invoice_updated', summary: `Merged ${sources.length} draft(s) into ${target.number} (${sources.map((s) => s.number).join(', ')} voided)`, entityType: 'invoice', entityId: target.id })
      setSel(new Set())
      setMergeOpen(false)
      setExpandedId(target.id)
      onChanged && onChanged()
    } catch (e) { setErr(e.message || String(e)) }
    setBulkBusy(false)
  }

  const withCard = open.filter((i) => i.savedCard)
  const needsZip = open.filter((i) => i.savedCard?.needsZip)
  const totals = {
    count: open.length,
    amount: open.reduce((s, i) => s + Number(i.total || 0), 0),
    cardCount: withCard.length,
    cardAmount: withCard.reduce((s, i) => s + Number(i.total || 0), 0),
    needsZipCount: needsZip.length,
    viewedCount: open.filter((i) => i.viewedAt).length,
  }

  async function startRun() {
    const ids = filtered.map((i) => i.id)
    if (!ids.length) return
    const cardN = filtered.filter((i) => i.savedCard).length
    const zipN = filtered.filter((i) => i.savedCard?.needsZip).length
    const sendN = ids.length - cardN
    if (!window.confirm(
      `Run billing on ${ids.length} invoice${ids.length === 1 ? '' : 's'} (${money(totalsOf(filtered))})?\n\n` +
      `• ${cardN - zipN} with a chargeable card → charge + email receipt\n` +
      (zipN ? `• ${zipN} card${zipN === 1 ? '' : 's'} missing billing ZIP → invoice sent instead (can't charge)\n` : '') +
      `• ${sendN} with no card → send invoice (email/SMS)\n\n` +
      `Charges run one at a time. Declines are skipped and listed at the end.`
    )) return

    setErr('')
    setSummary(null)
    setResults({})
    setRunning(true)
    cancelRef.current = false
    const acc = {}
    let cursor = 0
    let charged = 0, sent = 0, failed = 0, chargedTotal = 0
    try {
      while (true) {
        if (cancelRef.current) break
        const res = await runBilling(ids, cursor)
        for (const r of res.results || []) {
          acc[r.invoice_id] = r
          if (r.outcome === 'charged') { charged++; chargedTotal += Number(r.charged || 0) }
          else if (r.outcome === 'sent') sent++
          else if (r.outcome === 'failed') failed++
        }
        setResults({ ...acc })
        cursor = res.next_cursor
        setProgress({ total: ids.length, processed: Math.min(cursor, ids.length) })
        if (res.done) break
      }
      const s = { charged, sent, failed, chargedTotal }
      setSummary(s)
      logActivity({
        type: 'billing_run',
        summary: `Billing run: charged ${charged} (${money(chargedTotal)}), sent ${sent}, failed ${failed} of ${ids.length} invoice(s)`,
        entityType: 'invoice',
      })
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setRunning(false)
      setProgress(null)
      onChanged && onChanged() // pull fresh statuses (paid/sent/viewed)
    }
  }

  const FILTERS = [['all', 'All'], ['card', '💳 Card on file'], ['noc', 'No card'], ['viewed', 'Viewed'], ['notviewed', 'Not viewed']]

  return (
    <div>
      {/* summary */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14, alignItems: 'stretch' }}>
        <SummaryCard label="Ready to run" value={money(totals.amount)} sub={`${totals.count} open invoice${totals.count === 1 ? '' : 's'}`} accent="#b07a1e" />
        <SummaryCard label="Card on file" value={money(totals.cardAmount)} sub={`${totals.cardCount - totals.needsZipCount} chargeable${totals.needsZipCount ? ` · ${totals.needsZipCount} need ZIP ⚠` : ''}`} accent={GREEN} />
        <SummaryCard label="To send" value={money(totals.amount - totals.cardAmount)} sub={`${totals.count - totals.cardCount} invoice emails/texts`} accent="#5d6b63" />
        <SummaryCard label="Viewed" value={String(totals.viewedCount)} sub="pay link opened" accent="#6b4fa0" />
        <div style={{ flex: 1 }} />
        <button
          onClick={startRun}
          disabled={running || !filtered.length || loading}
          style={{ alignSelf: 'center', background: running ? '#9aa69e' : GREEN, color: '#fff', border: 'none', borderRadius: 10, padding: '12px 22px', fontSize: 14, fontWeight: 700, cursor: running ? 'default' : 'pointer' }}
        >
          {running ? `Running… ${progress ? `${progress.processed}/${progress.total}` : ''}` : `⚡ Run billing (${filtered.length})`}
        </button>
      </div>

      {running && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, height: 8, background: '#eef1ee', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ width: `${progress ? (progress.processed / progress.total) * 100 : 0}%`, height: '100%', background: GREEN, transition: 'width .3s' }} />
          </div>
          <button onClick={() => { cancelRef.current = true }} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Stop after this batch</button>
        </div>
      )}

      {err && <div style={{ marginBottom: 12, background: '#fdf1ef', border: '1px solid #f2c7c0', color: '#9a2c1e', borderRadius: 11, padding: '9px 13px', fontSize: 12.5 }}>{err}</div>}
      {summary && !running && (
        <div style={{ marginBottom: 12, background: summary.failed ? '#fff7e9' : '#eef7f1', border: `1px solid ${summary.failed ? '#f0dcb0' : '#cfe7da'}`, color: summary.failed ? '#8a6320' : '#1f7a4d', borderRadius: 11, padding: '9px 13px', fontSize: 12.5 }}>
          ✅ Run complete: <b>{summary.charged}</b> charged (<b>{money(summary.chargedTotal)}</b>), <b>{summary.sent}</b> sent,{' '}
          {summary.failed ? <b style={{ color: '#9a2c1e' }}>{summary.failed} failed</b> : '0 failed'}.
          {summary.failed > 0 && ' Failed rows are marked below — fix the card/contact and run those again.'}
        </div>
      )}

      {/* bulk selection bar */}
      {sel.size > 0 && (
        <div style={{ marginBottom: 12, background: '#1a2420', color: '#fff', borderRadius: 11, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
          <b>{sel.size} selected</b>
          <span style={{ color: '#9aa69e', fontSize: 11.5 }}>
            {allDrafts ? `${money(selected.reduce((s, i) => s + Number(i.total || 0), 0))} total` : 'sent invoices are locked (deselect them to merge)'}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={voidSelected} disabled={bulkBusy} style={{ background: '#fdecea', color: '#9a2c1e', border: 'none', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>Void {sel.size}</button>
          <button
            onClick={openMerge}
            disabled={bulkBusy || !allDrafts || sel.size < 2}
            title={!allDrafts ? 'Only draft invoices can be merged (sent are locked)' : sel.size < 2 ? 'Select at least 2 drafts' : 'Combine line items + photos into one invoice'}
            style={{ background: allDrafts && sel.size >= 2 ? '#e7f1eb' : '#3a4a42', color: allDrafts && sel.size >= 2 ? GREEN : '#9aa69e', border: 'none', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 700, cursor: allDrafts && sel.size >= 2 ? 'pointer' : 'default' }}
          >⛙ Merge {sel.size}</button>
          <button onClick={() => setSel(new Set())} style={{ background: 'transparent', color: '#9aa69e', border: '1px solid #3a4a42', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, cursor: 'pointer' }}>Clear</button>
        </div>
      )}

      {/* filters */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {FILTERS.map(([id, label]) => {
          const n = id === 'all' ? open.length
            : id === 'card' ? totals.cardCount
            : id === 'noc' ? totals.count - totals.cardCount
            : id === 'viewed' ? totals.viewedCount
            : totals.count - totals.viewedCount
          const on = filter === id
          return (
            <button key={id} onClick={() => setFilter(id)} style={{ background: on ? GREEN : '#f3f5f2', color: on ? '#fff' : '#5d6b63', border: 'none', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {label}{n ? ` · ${n}` : ''}
            </button>
          )
        })}
        <span style={{ flex: 1 }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client or #…" style={{ ...inp, width: 200 }} />
      </div>

      {/* list */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
        {/* select-all row */}
        {filtered.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid #f0f2ef', fontSize: 11.5, color: '#7c8a82', cursor: 'pointer', background: '#fafbfa' }}>
            <input type="checkbox" checked={sel.size > 0 && sel.size === filtered.length} onChange={toggleSelAll} style={{ accentColor: GREEN }} />
            {sel.size > 0 && sel.size === filtered.length ? 'Deselect all (filtered)' : `Select all (${filtered.length})`}
          </label>
        )}
        {loading && !open.length ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading invoices…</div>
        ) : !filtered.length ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>
            {open.length ? 'Nothing matches this filter.' : 'No open invoices — everything is paid or void. 🎉'}
          </div>
        ) : filtered.map((inv) => {
          const r = results[inv.id]
          const expanded = expandedId === inv.id
          return (
            <div key={inv.id} style={{ borderBottom: '1px solid #f0f2ef', background: r?.outcome === 'failed' ? '#fdf6f5' : 'transparent' }}>
              <div
                onClick={() => setExpandedId(expanded ? null : inv.id)}
                style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, padding: '10px 14px', cursor: 'pointer', flexWrap: isMobile ? 'wrap' : 'nowrap' }}
              >
                <input
                  type="checkbox"
                  checked={sel.has(inv.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSel(inv.id)}
                  style={{ accentColor: GREEN, flex: 'none', width: 15, height: 15 }}
                />
                <span style={{ flex: 'none', color: '#9aa69e', fontSize: 11, width: 12 }}>{expanded ? '▾' : '▸'}</span>
                <div style={{ minWidth: 0, flex: isMobile ? '1 1 100%' : 1.6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inv.customerName || 'Unknown'}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{inv.number}{inv.status === 'draft' ? (isCurrentMonth(inv.createdAt) ? ' · draft — accumulating stops' : ` · draft — ${monthName(inv.createdAt)} ready to send`) : ' · sent'}</div>
                </div>
                {!isMobile && (
                  <div style={{ flex: 1, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {inv.savedCard
                      ? inv.savedCard.needsZip
                        ? <span style={chip('#fdf2e0', '#b07a1e')} title="This saved card has no billing ZIP — the run will send the invoice instead of charging. Ask the client to re-save their card in the portal.">⚠ {(inv.savedCard.brand || 'card').toUpperCase()} ••{inv.savedCard.last4} · needs ZIP</span>
                        : <span style={chip('#e7f1eb', GREEN)} title="Saved card will be charged">💳 {(inv.savedCard.brand || 'card').toUpperCase()} ••{inv.savedCard.last4}</span>
                      : <span style={chip('#eef0ed', '#7c8a82')}>no card</span>}
                    {inv.viewedAt
                      ? <span style={chip('#efe9f7', '#6b4fa0')} title={`Pay link first opened ${fmtViewed(inv.viewedAt)}`}>👁 Viewed {fmtViewed(inv.viewedAt)}</span>
                      : <span style={chip('#f5f6f4', '#b3bcb6')}>not viewed</span>}
                  </div>
                )}
                {isMobile && (
                  <div style={{ flex: '1 1 100%', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {inv.savedCard
                      ? inv.savedCard.needsZip
                        ? <span style={chip('#fdf2e0', '#b07a1e')}>⚠ ••{inv.savedCard.last4} · needs ZIP</span>
                        : <span style={chip('#e7f1eb', GREEN)}>💳 ••{inv.savedCard.last4}</span>
                      : <span style={chip('#eef0ed', '#7c8a82')}>no card</span>}
                    {inv.viewedAt ? <span style={chip('#efe9f7', '#6b4fa0')}>👁 {fmtViewed(inv.viewedAt)}</span> : null}
                  </div>
                )}
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, flex: 'none' }}>{money(inv.total)}</div>
                <div style={{ flex: 'none', minWidth: 150, textAlign: 'right' }}>
                  {r ? <ResultBadge r={r} /> : running ? <span style={{ fontSize: 11.5, color: '#9aa69e' }}>queued…</span> : null}
                </div>
              </div>
              {expanded && (
                <InvoicePreview inv={inv} isMobile={isMobile} onChanged={onChanged} onOpenInvoice={onOpenInvoice} />
              )}
            </div>
          )
        })}
      </div>

      <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 10 }}>
        Click a row to preview / edit (drafts only — sent are locked). Check rows to void or merge in bulk.
        Cards are charged one at a time; each customer gets a receipt email. Invoices without a card get the invoice email (SMS if no email on file).
        A card saved without its billing ZIP can't be charged (surcharge rule) — it's sent instead so the client can pay online. Re-running an invoice is safe: already-paid ones are skipped.
      </div>

      {/* merge target picker */}
      {mergeOpen && (
        <div onClick={() => !bulkBusy && setMergeOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 16px', overflowY: 'auto' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: '100%', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>⛙ Merge {selected.length} drafts</div>
            <div style={{ fontSize: 12.5, color: '#7c8a82', marginTop: 3, marginBottom: 14 }}>
              Everything folds into the target: line items (stop links and photos intact) and attached photos move over; the other drafts are voided.
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#5d6b63', marginBottom: 6 }}>MERGE INTO (keep this one)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
              {selected.map((i) => (
                <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${mergeTargetId === i.id ? GREEN : '#e6eae6'}`, background: mergeTargetId === i.id ? '#f3faf5' : '#fff', borderRadius: 9, padding: '9px 11px', cursor: 'pointer', fontSize: 13 }}>
                  <input type="radio" name="merge-target" checked={mergeTargetId === i.id} onChange={() => setMergeTargetId(i.id)} style={{ accentColor: GREEN }} />
                  <span style={{ flex: 1 }}><b>{i.number}</b> · {i.customerName} <span style={{ color: '#9aa69e' }}>({i.items.length} lines, {money(i.total)})</span></span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 9 }}>
              <button onClick={() => setMergeOpen(false)} disabled={bulkBusy} style={{ flex: 'none', background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doMerge} disabled={bulkBusy} style={{ flex: 1, background: GREEN, color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: bulkBusy ? 0.6 : 1 }}>{bulkBusy ? 'Merging…' : `Merge into ${byId[mergeTargetId]?.number || ''}`}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- inline preview / editor ---------------------------------------------------
function InvoicePreview({ inv, isMobile, onChanged, onOpenInvoice }) {
  const [photos, setPhotos] = useState(null) // null = loading
  const [editing, setEditing] = useState(false)
  const [items, setItems] = useState(null) // edit copy while editing
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const editable = inv.status === 'draft'

  useEffect(() => {
    let cancelled = false
    setPhotos(null)
    loadInvoicePhotos(inv.id).then((rows) => { if (!cancelled) setPhotos(rows) }).catch(() => { if (!cancelled) setPhotos([]) })
    return () => { cancelled = true }
  }, [inv.id, inv.items])

  const shownTotals = editing && items ? invoiceTotals(items, inv.discount) : { subtotal: inv.subtotal, total: inv.total }

  function startEdit() {
    setItems(inv.items.map((it) => ({ ...it })))
    setEditing(true)
  }
  function setItem(i, patch) {
    setItems((cur) => cur.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }
  async function save() {
    setSaving(true)
    setErr('')
    try {
      await updateInvoice(inv.id, {
        customerId: inv.customerId,
        status: inv.status,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        notes: inv.notes,
        discount: inv.discount,
        billToName: inv.billToName,
        billToEmail: inv.billToEmail,
        billToPhone: inv.billToPhone,
        items: (items || []).map((it) => ({ title: it.title, description: it.description, quantity: it.quantity, unitPrice: it.unitPrice, stopId: it.stopId })),
      })
      setEditing(false)
      onChanged && onChanged()
    } catch (e) {
      setErr(e.message || String(e))
    }
    setSaving(false)
  }

  const th = { padding: '5px 8px', fontSize: 10.5, color: '#7c8a82', textTransform: 'uppercase', letterSpacing: '.04em', textAlign: 'left', borderBottom: '1px solid #e6ece8' }
  const td = { padding: '5px 8px', fontSize: 12.5, color: '#1a2420', borderBottom: '1px solid #f0f2ef', verticalAlign: 'top' }

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ background: '#fafbfa', borderTop: '1px solid #eef1ee', padding: isMobile ? '12px 10px' : '14px 18px 16px 47px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{inv.number} <span style={{ color: '#7c8a82', fontWeight: 500 }}>· {inv.customerName}</span></div>
        <span style={{ fontSize: 11, color: '#9aa69e' }}>{inv.issueDate ? `issued ${String(inv.issueDate).slice(0, 10)}` : ''}{inv.dueDate ? ` · due ${String(inv.dueDate).slice(0, 10)}` : ''}</span>
        <span style={{ flex: 1 }} />
        {onOpenInvoice && <button onClick={() => onOpenInvoice(inv.id)} style={{ background: 'none', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 7, padding: '5px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Open full editor ↗</button>}
        {editable && !editing && (
          <button onClick={startEdit} style={{ background: '#eef7f1', border: '1px solid #cfe7da', color: GREEN, borderRadius: 7, padding: '5px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>✏️ Edit lines</button>
        )}
        {editable && editing && (
          <>
            <button onClick={() => setEditing(false)} disabled={saving} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 7, padding: '5px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ background: GREEN, border: 'none', color: '#fff', borderRadius: 7, padding: '5px 12px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
          </>
        )}
      </div>

      {err && <div style={{ marginBottom: 8, background: '#fdf1ef', border: '1px solid #f2c7c0', color: '#9a2c1e', borderRadius: 8, padding: '7px 10px', fontSize: 12 }}>{err}</div>}

      <div style={{ overflowX: 'auto', background: '#fff', border: '1px solid #e6ece8', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
          <thead>
            <tr>
              <th style={{ ...th, width: '44%' }}>Item</th>
              <th style={{ ...th, textAlign: 'center' }}>Qty</th>
              <th style={{ ...th, textAlign: 'right' }}>Rate</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              {editing && <th style={th} />}
            </tr>
          </thead>
          <tbody>
            {(editing ? items : inv.items).map((it, i) => (
              <tr key={it.id || i}>
                <td style={td}>
                  {editing ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <input value={it.title || ''} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="Title — e.g. Trash pickup · Nov 3–7" style={inp} />
                      <input value={it.description || ''} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Description (optional)" style={{ ...inp, color: '#5d6b63' }} />
                    </div>
                  ) : (
                    <>
                      {it.title && <div style={{ fontWeight: 600 }}>{it.title}</div>}
                      {it.description && <div style={{ color: '#5d6b63' }}>{it.description}</div>}
                    </>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {editing ? <input type="number" min="0" step="any" value={it.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} style={{ ...inp, width: 62, textAlign: 'center' }} /> : it.quantity}
                </td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {editing ? <input type="number" min="0" step="any" value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: e.target.value })} style={{ ...inp, width: 78, textAlign: 'right' }} /> : money(it.unitPrice)}
                </td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{money(editing && items ? (Number(it.quantity || 0) * Number(it.unitPrice || 0)) : it.amount)}</td>
                {editing && (
                  <td style={{ ...td, width: 30 }}>
                    <button onClick={() => setItems((cur) => cur.filter((_, idx) => idx !== i))} title="Remove line" style={{ background: 'none', border: 'none', color: '#9a2c1e', cursor: 'pointer', fontSize: 14 }}>×</button>
                  </td>
                )}
              </tr>
            ))}
            {editing && (
              <tr>
                <td colSpan={5} style={{ ...td, borderBottom: 'none' }}>
                  <button onClick={() => setItems((cur) => [...cur, { title: '', description: '', quantity: 1, unitPrice: '' }])} style={{ background: 'none', border: '1px dashed #cfe0d5', color: GREEN, borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', width: '100%' }}>+ Add line</button>
                </td>
              </tr>
            )}
            {!editing && !inv.items.length && (
              <tr><td colSpan={4} style={{ ...td, color: '#9aa69e', borderBottom: 'none' }}>No line items yet — driver stop lines accumulate here through the month.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={editing ? 4 : 3} style={{ ...td, textAlign: 'right', color: '#5d6b63', borderBottom: 'none' }}>Subtotal</td>
              <td style={{ ...td, textAlign: 'right', borderBottom: 'none' }}>{money(shownTotals.subtotal)}</td>
            </tr>
            {Number(inv.discount) > 0 && (
              <tr>
                <td colSpan={editing ? 4 : 3} style={{ ...td, textAlign: 'right', color: '#5d6b63', borderBottom: 'none' }}>Discount</td>
                <td style={{ ...td, textAlign: 'right', color: '#9a2c1e', borderBottom: 'none' }}>-{money(inv.discount)}</td>
              </tr>
            )}
            <tr>
              <td colSpan={editing ? 4 : 3} style={{ ...td, textAlign: 'right', fontWeight: 700, borderBottom: 'none', fontSize: 13.5 }}>Total</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: GREEN, borderBottom: 'none', fontSize: 13.5 }}>{money(shownTotals.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {photos === null ? (
        <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 8 }}>Loading photos…</div>
      ) : photos.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10.5, color: '#7c8a82', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 }}>Photos & attachments ({photos.length})</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {photos.map((p) => (
              <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                <img src={p.url} alt={p.note || 'Service photo'} title={p.note || ''} style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #e6ece8' }} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function totalsOf(rows) {
  return rows.reduce((s, i) => s + Number(i.total || 0), 0)
}

function ResultBadge({ r }) {
  if (r.outcome === 'charged') return <span style={chip('#e7f1eb', GREEN)} title={r.fee ? `Includes ${money(r.fee)} card surcharge` : ''}>✓ charged{money(r.charged)}</span>
  if (r.outcome === 'sent') {
    if (r.warn === 'card_missing_zip') {
      return <span style={chip('#fdf2e0', '#b07a1e')} title="Saved card has no billing ZIP, so it wasn't charged — invoice was sent instead. Client needs to re-save their card.">⚠ needs ZIP — sent instead</span>
    }
    return <span style={chip('#e8eef7', '#2c5aa0')}>✓ sent {r.channel || ''}</span>
  }
  if (r.outcome === 'skipped') return <span style={chip('#eef0ed', '#7c8a82')}>– {r.detail || 'skipped'}</span>
  return <span style={chip('#fdecea', '#9a2c1e')} title={r.detail || ''}>✗ {r.detail || 'failed'}</span>
}

function SummaryCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 12, padding: '12px 16px', minWidth: 130 }}>
      <div style={{ fontSize: 11, color: '#7c8a82', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: accent, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9aa69e', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}
