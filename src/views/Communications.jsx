// Communications: every text and email the business has sent (or received),
// with full-message receipts. Texts come from sms_messages; emails from
// email_messages (receipts started 2026-10-14 — earlier emails have no
// content on file, only activity-log one-liners).
import { useEffect, useRef, useState } from 'react'
import { loadComms, searchCustomers, subscribeComms } from '../lib/commsData.js'

const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 14, marginBottom: 16, overflow: 'hidden' }
const inp = { background: '#fff', border: '1px solid #d9e2dc', borderRadius: 9, padding: '8px 11px', fontSize: 13, color: '#1a2420', outline: 'none' }

const STATUS_STYLE = {
  sent: { color: '#1f7a4d', bg: '#e7f4ed' },
  received: { color: '#2f6db0', bg: '#e8f0fa' },
  failed: { color: '#b03a2e', bg: '#fbeae7' },
  paused: { color: '#b07d18', bg: '#fbf3df' },
  blocked_optout: { color: '#6b5a8a', bg: '#efeaf7' },
}

const PURPOSE_LABEL = {
  invoice: 'Invoice', reminder: 'Reminder', arrival: 'Arrival', complete: 'Complete',
  service_reminder: 'Pickup reminder', portal: 'Portal', staff_alert: 'Staff alert',
  payments: 'Payment', manual: 'Manual', randy_sms: 'Randy', on_my_way: 'On my way',
  reset: 'Password reset', announcement: 'Announcement', estimate: 'Estimate', other: 'Other',
}

const fmtTime = (v) => new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const snippet = (r) => {
  const t = r.channel === 'email' ? `${r.subject || ''} — ${r.body_text || ''}` : (r.body || '')
  return t.replace(/\s+/g, ' ').trim()
}
const recipient = (r) => (r.channel === 'email' ? r.to_email : r.direction === 'out' ? r.to_number : r.from_number)

function Detail({ row, onClose }) {
  const isEmail = row.channel === 'email'
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,25,20,.45)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, width: 640, maxWidth: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #eef1ee', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {isEmail ? (row.subject || '(no subject)') : `${row.direction === 'out' ? 'Text to' : 'Text from'} ${recipient(row)}`}
            </div>
            <div style={{ fontSize: 12, color: '#7c8a82', marginTop: 2 }}>
              {row.customerName ? `${row.customerName} · ` : ''}{recipient(row)} · {fmtTime(row.created_at)}
              {row.purpose ? ` · ${PURPOSE_LABEL[row.purpose] || row.purpose}` : ''}
              {row.sent_by ? ` · by ${row.sent_by}` : ''}
            </div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, ...(STATUS_STYLE[row.status] || STATUS_STYLE.sent) }}>{row.status}</span>
          <div onClick={onClose} style={{ cursor: 'pointer', color: '#7c8a82', fontSize: 18, padding: '0 2px' }}>✕</div>
        </div>
        {row.error && <div style={{ margin: '12px 18px 0', background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 9, padding: '8px 12px', fontSize: 12.5 }}>{row.error}</div>}
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {isEmail ? (
            row.body_html
              ? <iframe title="email preview" sandbox="" srcDoc={row.body_html} style={{ width: '100%', height: 380, border: '1px solid #e6eae6', borderRadius: 10, background: '#fff' }} />
              : <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, margin: 0 }}>{row.body_text || '(no content logged)'}</pre>
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, margin: 0 }}>{row.body}</pre>
          )}
        </div>
        <div style={{ padding: '10px 18px', borderTop: '1px solid #eef1ee', fontSize: 11.5, color: '#9aa69e', fontFamily: 'ui-monospace,monospace' }}>
          {row.provider}{row.external_id ? ` · ${row.external_id}` : ''}{row.from_email ? ` · from ${row.from_email}` : ''}
          {row.related_type ? ` · ${row.related_type} ${row.related_id || ''}` : ''}
        </div>
      </div>
    </div>
  )
}

export default function Communications() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [channel, setChannel] = useState('all')
  const [direction, setDirection] = useState('all')
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(150)
  const [sel, setSel] = useState(null)
  const [cust, setCust] = useState(null) // {id, name}
  const [custQ, setCustQ] = useState('')
  const [custOpts, setCustOpts] = useState([])
  const timer = useRef(null)

  async function refresh(l = limit) {
    try {
      setRows(await loadComms({ channel, direction, status, q, customerId: cust?.id || null, limit: l }))
      setErr('')
    } catch (e) { setErr(e.message || String(e)) }
  }
  useEffect(() => { refresh(limit) }, [channel, direction, status, cust])
  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => refresh(limit), 300)
    return () => clearTimeout(timer.current)
  }, [q])
  useEffect(() => subscribeComms((r) => {
    setRows((prev) => (prev && (!cust || r.customer_id === cust.id) ? [r, ...prev].slice(0, 400) : prev))
  }), [cust])

  useEffect(() => {
    clearTimeout(timer.current)
    if (!custQ.trim()) { setCustOpts([]); return }
    timer.current = setTimeout(() => searchCustomers(custQ.trim()).then(setCustOpts).catch(() => setCustOpts([])), 250)
    return () => clearTimeout(timer.current)
  }, [custQ])

  const seg = (v, cur, set, label) => (
    <button key={v} onClick={() => set(v)} style={{ border: 'none', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: cur === v ? 700 : 500, cursor: 'pointer', background: cur === v ? '#1f7a4d' : 'transparent', color: cur === v ? '#fff' : '#5d6b63' }}>{label}</button>
  )

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#1a2420' }}>Communications</div>
        <div style={{ fontSize: 12.5, color: '#7c8a82' }}>Receipts for every text and email — click any row for the full message.</div>
      </div>

      {err && <div style={{ background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      <div style={{ ...card, padding: '10px 12px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', background: '#eef1ee', borderRadius: 10, padding: 3, gap: 2 }}>
          {[['all', 'All'], ['sms', 'Texts'], ['email', 'Emails']].map(([v, l]) => seg(v, channel, setChannel, l))}
        </div>
        <div style={{ display: 'flex', background: '#eef1ee', borderRadius: 10, padding: 3, gap: 2 }}>
          {[['all', 'Both ways'], ['out', 'Sent'], ['in', 'Received']].map(([v, l]) => seg(v, direction, setDirection, l))}
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="all">Any status</option>
          <option value="sent">Sent</option>
          <option value="received">Received</option>
          <option value="failed">Failed</option>
          <option value="paused">Paused</option>
          <option value="blocked_optout">Opted out</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search message, subject, address…" style={{ ...inp, flex: '1 1 180px', minWidth: 150 }} />
        <div style={{ position: 'relative', flex: '1 1 160px', minWidth: 140 }}>
          {cust ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#e7f4ed', color: '#1f7a4d', borderRadius: 9, padding: '7px 11px', fontSize: 12.5, fontWeight: 600 }}>
              {cust.name}
              <span onClick={() => { setCust(null); setCustQ('') }} style={{ cursor: 'pointer', fontWeight: 800 }}>×</span>
            </span>
          ) : (
            <>
              <input value={custQ} onChange={(e) => setCustQ(e.target.value)} placeholder="Filter by client…" style={{ ...inp, width: '100%' }} />
              {custOpts.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: '#fff', border: '1px solid #e0e7e2', borderRadius: 10, boxShadow: '0 8px 24px rgba(20,40,30,.14)', zIndex: 50, overflow: 'hidden' }}>
                  {custOpts.map((c) => (
                    <div key={c.id} onClick={() => { setCust(c); setCustOpts([]); setCustQ('') }} style={{ padding: '9px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f2f4f2' }}>
                      {c.name}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div style={card}>
        {rows === null ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9aa69e', fontSize: 13 }}>Nothing matches these filters yet.</div>
        ) : rows.map((r, i) => {
          const st = STATUS_STYLE[r.status] || STATUS_STYLE.sent
          return (
            <div key={`${r.channel}-${r.id}`} onClick={() => setSel(r)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: i === rows.length - 1 ? 'none' : '1px solid #f2f4f2', cursor: 'pointer' }}>
              <div style={{ width: 30, height: 30, borderRadius: 9, background: r.channel === 'email' ? '#e8f0fa' : '#e7f4ed', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flex: 'none' }}>
                {r.channel === 'email' ? '✉' : '💬'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1a2420', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.customerName || recipient(r)}
                  <span style={{ fontWeight: 400, color: '#7c8a82', fontSize: 12 }}> · {recipient(r)}</span>
                </div>
                <div style={{ fontSize: 12.5, color: '#5d6b63', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                  {r.direction === 'in' ? '↩ ' : ''}{snippet(r) || '(empty)'}
                </div>
              </div>
              <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, color: st.color, background: st.bg }}>{r.status}</span>
              <div style={{ flex: 'none', fontSize: 11.5, color: '#9aa69e', width: 108, textAlign: 'right' }}>{fmtTime(r.created_at)}</div>
            </div>
          )
        })}
      </div>

      {rows && rows.length >= limit && (
        <button onClick={() => { const l = limit + 150; setLimit(l); refresh(l) }} style={{ ...inp, cursor: 'pointer', fontWeight: 600, margin: '0 auto', display: 'block' }}>
          Load more
        </button>
      )}

      {sel && <Detail row={sel} onClose={() => setSel(null)} />}
    </div>
  )
}
