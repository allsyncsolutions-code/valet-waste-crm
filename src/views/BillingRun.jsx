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

import { useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { runBilling } from '../lib/paymentsData.js'
import { logActivity } from '../lib/activityData.js'

const GREEN = '#1f7a4d'
const money = (v) => '$' + Number(v || 0).toFixed(2)
const fmtViewed = (ts) => {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch { return '' }
}

const chip = (bg, color) => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: bg, color, whiteSpace: 'nowrap' })

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
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client or #…" style={{ border: '1px solid #dde2dd', borderRadius: 8, padding: '7px 11px', fontSize: 12.5, width: 200, outline: 'none' }} />
      </div>

      {/* list */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
        {loading && !open.length ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading invoices…</div>
        ) : !filtered.length ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>
            {open.length ? 'Nothing matches this filter.' : 'No open invoices — everything is paid or void. 🎉'}
          </div>
        ) : filtered.map((inv) => {
          const r = results[inv.id]
          return (
            <div
              key={inv.id}
              onClick={() => onOpenInvoice && onOpenInvoice(inv.id)}
              style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14, padding: '10px 14px', borderBottom: '1px solid #f0f2ef', cursor: onOpenInvoice ? 'pointer' : 'default', flexWrap: isMobile ? 'wrap' : 'nowrap', background: r?.outcome === 'failed' ? '#fdf6f5' : 'transparent' }}
            >
              <div style={{ minWidth: 0, flex: isMobile ? '1 1 100%' : 1.6 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inv.customerName || 'Unknown'}</div>
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{inv.number}{inv.status === 'draft' ? ' · draft (still accumulating stops)' : ' · sent'}</div>
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
          )
        })}
      </div>

      <div style={{ fontSize: 11.5, color: '#9aa69e', marginTop: 10 }}>
        Cards are charged one at a time; each customer gets a receipt email. Invoices without a card get the invoice email (SMS if no email on file).
        A card saved without its billing ZIP can't be charged (surcharge rule) — it's sent instead so the client can pay online. Re-running an invoice is safe: already-paid ones are skipped.
      </div>
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
