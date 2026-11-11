// Payments tab — everything that ran through Run Merchant, read-only, from
// their Reporting API (payments fn `reporting` action). Two sub-tabs:
//
//   • Transactions — every card charge/attempt (approved + declined), joined to
//     our invoice # / customer when the order_id is one of our invoice UUIDs.
//     Clicking an invoice # jumps to that invoice in the Invoicing tab.
//   • Funding — the batches Run deposits to the bank (net sales, fees,
//     adjustments, funding amount). Funding shows up 1–2 business days after
//     the transactions settle; today's unsettled activity won't appear here.
//
// Date presets cover the ranges Randy asks about (this/last month, last 30
// days, this/last quarter, YTD, last year) plus a custom from/to range.

import { useEffect, useMemo, useState } from 'react'
import { runReporting } from '../lib/paymentsData.js'

const GREEN = '#1f7a4d'
const RED = '#b3372f'
const money = (v) => '$' + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const BRANDS = { 1: 'Visa', 2: 'Mastercard', 3: 'Discover', 4: 'Amex' }

const fmtDate = (ts) => {
  try { return new Date(norm(ts)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return '' }
}
const fmtTime = (ts) => {
  try { return new Date(norm(ts)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}
// Run's timestamps carry 4–6 fractional-second digits; JS Date only parses
// exactly 3 (Safari rejects the rest outright) — strip them before parsing.
const norm = (ts) => (typeof ts === 'string' ? ts.replace(/\.\d+Z$/, 'Z') : ts)

// ---- date-range presets (local time) ----------------------------------------
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const PRESETS = [
  { id: 'this_month', label: 'This month', range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(n)] } },
  { id: 'last_month', label: 'Last month', range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))] } },
  { id: 'last_30', label: 'Last 30 days', range: () => { const n = new Date(); const s = new Date(n); s.setDate(s.getDate() - 29); return [iso(s), iso(n)] } },
  { id: 'this_quarter', label: 'This quarter', range: () => { const n = new Date(); const q = Math.floor(n.getMonth() / 3) * 3; return [iso(new Date(n.getFullYear(), q, 1)), iso(n)] } },
  { id: 'last_quarter', label: 'Last quarter', range: () => { const n = new Date(); const q = Math.floor(n.getMonth() / 3) * 3; return [iso(new Date(n.getFullYear(), q - 3, 1)), iso(new Date(n.getFullYear(), q, 0))] } },
  { id: 'ytd', label: 'Year to date', range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), 0, 1)), iso(n)] } },
  { id: 'last_year', label: 'Last year', range: () => { const n = new Date(); return [iso(new Date(n.getFullYear() - 1, 0, 1)), iso(new Date(n.getFullYear() - 1, 11, 31))] } },
  { id: 'all', label: 'All time', range: () => [null, null] },
]

const chip = (bg, color) => ({ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: bg, color, whiteSpace: 'nowrap' })
const card = { background: '#fff', border: '1px solid #e3e7e2', borderRadius: 12, padding: '14px 16px' }
const th = { textAlign: 'left', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#7c8a82', padding: '8px 10px', borderBottom: '1px solid #eef1ec', whiteSpace: 'nowrap' }
const td = { fontSize: 12.5, padding: '9px 10px', borderBottom: '1px solid #f2f4f0', whiteSpace: 'nowrap' }

export default function Payments({ app }) {
  const isMobile = app?.isMobile
  const [tab, setTab] = useState('transactions') // transactions | funding
  const [resultFilter, setResultFilter] = useState('all') // all | approved | declined (transactions tab)
  const [preset, setPreset] = useState('this_month')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const range = useMemo(() => {
    if (preset === 'custom') return [custom.from || null, custom.to || null]
    const p = PRESETS.find((x) => x.id === preset) || PRESETS[0]
    return p.range()
  }, [preset, custom])

  const kind = tab === 'funding' ? 'deposits' : 'transactions'
  const load = async () => {
    setLoading(true)
    setErr('')
    try {
      const d = await runReporting(kind, range[0], range[1])
      setData(d)
    } catch (e) {
      setErr((e && e.message) || String(e))
      setData(null)
    }
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [tab, preset, custom.from, custom.to])

  // While a new sub-tab/range loads, the previous response may still be in
  // state — never render it under the wrong table (that's how transactions
  // briefly showed up as "Invalid Date" funding rows).
  const showData = data && data.kind === kind ? data : null
  const items = (showData && showData.items) || []
  const summary = (showData && showData.summary) || {}
  const isTx = tab === 'transactions'
  // Approved/Declined card click filters the transactions list.
  const shown = isTx && resultFilter !== 'all'
    ? items.filter((t) => (resultFilter === 'approved' ? t.result === 'A' : t.result === 'C'))
    : items

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '12px 10px 40px' : '18px 22px 60px' }}>
      {/* Filter bar */}
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              style={preset === p.id
                ? { ...chip(GREEN, '#fff'), border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 12 }
                : { ...chip('#f1f4f0', '#3c4a43'), border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 12 }}
            >{p.label}</button>
          ))}
          <button
            onClick={() => setPreset('custom')}
            style={preset === 'custom'
              ? { ...chip(GREEN, '#fff'), border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 12 }
              : { ...chip('#f1f4f0', '#3c4a43'), border: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 12 }}
          >Custom</button>
          {preset === 'custom' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} style={{ border: '1px solid #dde2dd', borderRadius: 7, padding: '5px 8px', fontSize: 12.5 }} />
              →
              <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} style={{ border: '1px solid #dde2dd', borderRadius: 7, padding: '5px 8px', fontSize: 12.5 }} />
            </span>
          )}
          <button onClick={load} disabled={loading} style={{ ...chip('#fff', GREEN), border: '1px solid ' + GREEN, cursor: 'pointer', padding: '6px 12px', fontSize: 12, marginLeft: 'auto' }}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>
        {range[0] && <div style={{ fontSize: 11.5, color: '#7c8a82', marginTop: 8 }}>{fmtDate(range[0] + 'T12:00:00')} – {fmtDate(range[1] + 'T12:00:00')}</div>}
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {[{ id: 'transactions', label: 'Transactions' }, { id: 'funding', label: 'Funding (bank batches)' }].map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); setResultFilter('all') }} style={{
            border: 'none', cursor: 'pointer', padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
            background: tab === t.id ? '#15201b' : '#f1f4f0', color: tab === t.id ? '#fff' : '#3c4a43',
          }}>{t.label}</button>
        ))}
      </div>

      {err && <div style={{ ...card, borderColor: '#f0c9c5', color: RED, fontSize: 13, marginBottom: 14 }}>{err}</div>}
      {loading && !showData && <div style={{ ...card, color: '#7c8a82', fontSize: 13 }}>Loading from Run Merchant…</div>}

      {showData && !err && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
            {isTx ? (
              <>
                <div onClick={() => setResultFilter(resultFilter === 'approved' ? 'all' : 'approved')} title="Click to list approved charges" style={{ ...card, cursor: 'pointer', borderColor: resultFilter === 'approved' ? GREEN : '#e3e7e2', boxShadow: resultFilter === 'approved' ? `0 0 0 1px ${GREEN} inset` : 'none' }}><div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#7c8a82' }}>Approved</div><div style={{ fontSize: 20, fontWeight: 800, color: GREEN }}>{money(summary.approved_total)}</div><div style={{ fontSize: 11.5, color: '#7c8a82' }}>{summary.approved_count || 0} charge{summary.approved_count === 1 ? '' : 's'} — click to list</div></div>
                <div onClick={() => setResultFilter(resultFilter === 'declined' ? 'all' : 'declined')} title="Click to list declined attempts" style={{ ...card, cursor: 'pointer', borderColor: resultFilter === 'declined' ? RED : '#e3e7e2', boxShadow: resultFilter === 'declined' ? `0 0 0 1px ${RED} inset` : 'none' }}><div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#7c8a82' }}>Declined</div><div style={{ fontSize: 20, fontWeight: 800, color: Number(summary.declined_count) ? RED : '#3c4a43' }}>{summary.declined_count || 0}</div><div style={{ fontSize: 11.5, color: '#7c8a82' }}>attempt{summary.declined_count === 1 ? '' : 's'} — click to list</div></div>
                <div style={card}><div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#7c8a82' }}>Surcharges</div><div style={{ fontSize: 20, fontWeight: 800 }}>{money(summary.fees_total)}</div><div style={{ fontSize: 11.5, color: '#7c8a82' }}>passed to cards</div></div>
                <div style={card}><div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#7c8a82' }}>Total activity</div><div style={{ fontSize: 20, fontWeight: 800 }}>{summary.count || 0}</div><div style={{ fontSize: 11.5, color: '#7c8a82' }}>transaction{summary.count === 1 ? '' : 's'}</div></div>
              </>
            ) : (
              <>
                <div style={card}><div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#7c8a82' }}>Funded to bank</div><div style={{ fontSize: 20, fontWeight: 800, color: GREEN }}>{money(summary.funding_total)}</div><div style={{ fontSize: 11.5, color: '#7c8a82' }}>{summary.count || 0} batch{summary.count === 1 ? '' : 'es'}</div></div>
                <div style={card}><div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#7c8a82' }}>Net sales</div><div style={{ fontSize: 20, fontWeight: 800 }}>{money(summary.net_sales_total)}</div></div>
                <div style={card}><div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#7c8a82' }}>Fees</div><div style={{ fontSize: 20, fontWeight: 800 }}>{money(summary.fees_total)}</div><div style={{ fontSize: 11.5, color: '#7c8a82' }}>service + interchange</div></div>
              </>
            )}
          </div>

          {/* Table */}
          {isTx && resultFilter !== 'all' && (
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={chip(resultFilter === 'approved' ? '#e2f2e9' : '#fbe9e7', resultFilter === 'approved' ? GREEN : RED)}>Showing: {resultFilter === 'approved' ? 'Approved' : 'Declined'} · {shown.length}</span>
              <button onClick={() => setResultFilter('all')} style={{ ...chip('#f1f4f0', '#3c4a43'), border: 'none', cursor: 'pointer' }}>✕ Clear</button>
            </div>
          )}
          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              {isTx ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={th}>Date</th><th style={th}>Customer</th><th style={th}>Invoice</th><th style={th}>Card</th><th style={th}>Amount</th><th style={th}>Result</th>
                  </tr></thead>
                  <tbody>
                    {shown.length === 0 && <tr><td style={{ ...td, color: '#7c8a82' }} colSpan={6}>{items.length ? 'Nothing matches this filter — clear it above.' : 'No transactions in this range.'}</td></tr>}
                    {shown.map((t) => {
                      const ok = t.result === 'A'
                      // Row click jumps straight to the invoice (edit/resend/
                      // void there) whenever this charge matches one of ours.
                      const openInv = t.invoice_number ? () => app.openInvoice(t.order_id) : null
                      return (
                        <tr key={t.trans_id} onClick={openInv || undefined} title={openInv ? 'Click to open this invoice' : undefined} style={openInv ? { cursor: 'pointer' } : undefined}>
                          <td style={td}><div style={{ fontWeight: 600 }}>{fmtDate(t.trans_date)}</div><div style={{ fontSize: 11, color: '#7c8a82' }}>{fmtTime(t.trans_date)}</div></td>
                          <td style={td}>{t.customer_name || t.name || '—'}</td>
                          <td style={td}>
                            {t.invoice_number
                              ? <button onClick={(e) => { e.stopPropagation(); app.openInvoice(t.order_id) }} style={{ border: 'none', background: 'none', padding: 0, color: GREEN, fontWeight: 700, fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}>{t.invoice_number} →</button>
                              : <span style={{ color: '#b6bfb8', fontSize: 11.5 }}>—</span>}
                          </td>
                          <td style={td}>{BRANDS[t.card_brand_id] || 'Card'} ··{String(t.card_number || '').slice(-4)}</td>
                          <td style={{ ...td, fontWeight: 700, color: Number(t.amount) < 0 ? RED : undefined }}>{money(t.amount)}</td>
                          <td style={td}>
                            <span style={chip(ok ? '#e2f2e9' : '#fbe9e7', ok ? GREEN : RED)}>{ok ? 'Approved' : 'Declined'}</span>
                            {!ok && t.resp_text && <div style={{ fontSize: 11, color: RED, marginTop: 3 }}>{t.resp_text}</div>}
                            {ok && t.fee_amount > 0 && <div style={{ fontSize: 11, color: '#7c8a82', marginTop: 3 }}>+{money(t.fee_amount)} surcharge</div>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={th}>Funding date</th><th style={th}>Batch</th><th style={th}>Net sales</th><th style={th}>Fees</th><th style={th}>Adjustments</th><th style={th}>Funded</th>
                  </tr></thead>
                  <tbody>
                    {items.length === 0 && <tr><td style={{ ...td, color: '#7c8a82' }} colSpan={6}>No funding batches in this range. Batches appear 1–2 business days after the card charges settle.</td></tr>}
                    {items.map((d) => {
                      const fees = Number(d.fees || 0) + Number(d.service_charges || 0) + Number(d.interchange_fees || 0)
                      const red = (v) => (Number(v) < 0 ? { color: RED, fontWeight: 700 } : {})
                      return (
                      <tr key={d.funding_master_id}>
                        <td style={{ ...td, fontWeight: 600 }}>{fmtDate(d.funding_date)}</td>
                        <td style={{ ...td, color: '#7c8a82', fontSize: 11.5 }}>{d.funding_master_id}</td>
                        <td style={{ ...td, ...red(d.net_sales) }}>{money(d.net_sales)}</td>
                        <td style={{ ...td, ...red(fees) }}>{money(fees)}</td>
                        <td style={{ ...td, ...red(d.adjustments) }}>{Number(d.adjustments || 0) !== 0 ? money(d.adjustments) : '—'}</td>
                        <td style={{ ...td, fontWeight: 700, color: Number(d.funding_amount) < 0 ? RED : GREEN }}>{money(d.funding_amount)}</td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {!isTx && items.length > 0 && (
              <div style={{ padding: '10px 14px', fontSize: 11.5, color: '#7c8a82', borderTop: '1px solid #f2f4f0' }}>
                Funding batches land in the bank 1–2 business days after the charges settle — today’s card activity won’t show here yet.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
