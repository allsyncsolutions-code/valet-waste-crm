// Reports — where customers come from. Lead-source breakdown of the customer
// base for the active business line: all-time counts plus new signups in the
// last 90 days, so the team can see which channels are actually producing.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { LEAD_SOURCES, leadSourceLabel } from '../lib/leadSources.js'

const GREEN = '#1f7a4d'
const RECENT_MS = 90 * 86400000
const money = (v) => `$${Number(v || 0).toFixed(2)}`

export default function Reports({ app }) {
  const line = app.activeLine || 'waste'
  const [rows, setRows] = useState(null)
  const [invRows, setInvRows] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let cancelled = false
    setRows(null)
    supabase
      .from('customers')
      .select('id, lead_source, created_at, status')
      .eq('business_line', line)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setErr(error.message || String(error))
        else setRows(data || [])
      })
    // Paid invoices joined to the customer's lead source (revenue by source).
    setInvRows(null)
    supabase
      .from('invoices')
      .select('total, tip_amount, status, paid_at, customers!inner(lead_source, business_line)')
      .eq('status', 'paid')
      .eq('customers.business_line', line)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.warn('revenue report load failed', error)
        else setInvRows(data || [])
      })
    return () => { cancelled = true }
  }, [line])

  const { bySource, total, recentTotal } = useMemo(() => {
    const counts = new Map()
    let recent = 0
    const cutoff = Date.now() - RECENT_MS
    for (const c of rows || []) {
      const key = c.lead_source || ''
      const cur = counts.get(key) || { total: 0, recent: 0 }
      cur.total++
      const isRecent = new Date(c.created_at).getTime() >= cutoff
      if (isRecent) { cur.recent++; recent++ }
      counts.set(key, cur)
    }
    // Order: known sources by total desc, then unknown values, then Not set.
    const known = LEAD_SOURCES.map((s) => ({ key: s.value, label: s.label, ...(counts.get(s.value) || { total: 0, recent: 0 }) }))
      .filter((s) => s.total > 0)
      .sort((a, b) => b.total - a.total)
    const unknown = [...counts.entries()]
      .filter(([k]) => k && !LEAD_SOURCES.some((s) => s.value === k))
      .map(([k, v]) => ({ key: k, label: leadSourceLabel(k), ...v }))
      .sort((a, b) => b.total - a.total)
    const notSet = { key: '', label: 'Not set', ...(counts.get('') || { total: 0, recent: 0 }) }
    return {
      bySource: [...known, ...unknown, ...(notSet.total ? [notSet] : [])],
      total: rows ? rows.length : 0,
      recentTotal: recent,
    }
  }, [rows])

  const max = Math.max(1, ...bySource.map((s) => s.total))

  // Signups per week for the last 12 weeks (weeks start Monday), split
  // web-form vs everything else so the channel trend is visible.
  const weeks = useMemo(() => {
    const monday = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }
    const thisWeek = monday(Date.now()).getTime()
    const out = []
    for (let i = 11; i >= 0; i--) {
      const start = thisWeek - i * 7 * 86400000
      out.push({ start, end: start + 7 * 86400000, label: new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), total: 0, web: 0 })
    }
    for (const c of rows || []) {
      const t = new Date(c.created_at).getTime()
      const bucket = out.find((w) => t >= w.start && t < w.end)
      if (!bucket) continue
      bucket.total++
      if (c.lead_source === 'web_form') bucket.web++
    }
    return out
  }, [rows])
  const maxWeek = Math.max(1, ...weeks.map((w) => w.total))

  // Paid revenue by lead source (invoice total + tip).
  const revenueBySource = useMemo(() => {
    const m = new Map()
    let grand = 0
    for (const inv of invRows || []) {
      const key = inv.customers?.lead_source || ''
      const amt = Number(inv.total || 0) + Number(inv.tip_amount || 0)
      const cur = m.get(key) || { total: 0, count: 0 }
      cur.total += amt
      cur.count++
      grand += amt
      m.set(key, cur)
    }
    const toRow = ([k, v]) => ({ key: k, label: k ? leadSourceLabel(k) : 'Not set', ...v })
    return {
      rows: [...m.entries()].map(toRow).sort((a, b) => b.total - a.total),
      grand,
    }
  }, [invRows])
  const maxRev = Math.max(1, ...revenueBySource.rows.map((r) => r.total))

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '18px 16px 60px' }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 19, fontWeight: 800 }}>Reports</div>
        <div style={{ fontSize: 13, color: '#7c8a82' }}>Where your customers come from — lead sources for the {line} line.</div>
      </div>

      {err && <div style={{ background: '#fdecea', border: '1px solid #f5c6c0', color: '#a02c22', borderRadius: 10, padding: '10px 13px', fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {rows === null && !err && <div style={{ color: '#7c8a82', fontSize: 14 }}>Loading…</div>}

      {rows !== null && (
        <div style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', boxShadow: '0 1px 4px rgba(20,30,24,.07)' }}>
          <div style={{ display: 'flex', gap: 18, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 800 }}>{total}</div>
              <div style={{ fontSize: 12, color: '#7c8a82' }}>total customers</div>
            </div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 800, color: GREEN }}>{recentTotal}</div>
              <div style={{ fontSize: 12, color: '#7c8a82' }}>new in last 90 days</div>
            </div>
          </div>

          {bySource.length === 0 && <div style={{ color: '#7c8a82', fontSize: 13.5 }}>No customers on this line yet.</div>}

          {bySource.map((s) => (
            <div key={s.key || 'unset'} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginBottom: 4 }}>
                <span style={{ fontWeight: 700 }}>{s.label}</span>
                <span style={{ color: '#7c8a82' }}>
                  <b style={{ color: '#1c2620' }}>{s.total}</b> ({Math.round((s.total / Math.max(1, total)) * 100)}%)
                  {s.recent > 0 && <span style={{ color: GREEN, fontWeight: 700 }}> · +{s.recent} new</span>}
                </span>
              </div>
              <div style={{ height: 9, borderRadius: 5, background: '#eef2ee' }}>
                <div style={{ height: 9, borderRadius: 5, background: s.key === 'web_form' ? GREEN : '#7fb89d', width: `${Math.max(2, (s.total / max) * 100)}%` }} />
              </div>
            </div>
          ))}

          <div style={{ fontSize: 12, color: '#9aa69e', marginTop: 10, lineHeight: 1.5 }}>
            "Not set" = customers added before lead source tracking (or never set). Web Form = signed up through the public signup page.
          </div>
        </div>
      )}

      {rows !== null && (
        <div style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', marginTop: 14, boxShadow: '0 1px 4px rgba(20,30,24,.07)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <div style={{ fontSize: 15.5, fontWeight: 800 }}>Signups per week</div>
            <div style={{ fontSize: 12, color: '#7c8a82' }}>last 12 weeks</div>
          </div>
          {weeks.every((w) => w.total === 0) && <div style={{ color: '#7c8a82', fontSize: 13.5 }}>No signups in the last 12 weeks.</div>}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 110 }}>
            {weeks.map((w) => (
              <div key={w.start} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#4c5a51' }}>{w.total || ''}</div>
                <div style={{ width: '100%', maxWidth: 34, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 78 }}>
                  <div style={{ background: '#7fb89d', borderRadius: '4px 4px 0 0', height: `${(Math.max(0, w.total - w.web) / maxWeek) * 78}px` }} />
                  <div style={{ background: GREEN, borderRadius: w.total - w.web > 0 ? 0 : '4px 4px 0 0', height: `${(w.web / maxWeek) * 78}px` }} />
                </div>
                <div style={{ fontSize: 10, color: '#9aa69e', whiteSpace: 'nowrap' }}>{w.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#7c8a82', marginTop: 8 }}>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: GREEN, marginRight: 5 }} />Web Form</span>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: '#7fb89d', marginRight: 5 }} />All other sources</span>
          </div>
        </div>
      )}

      {invRows !== null && (
        <div style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', marginTop: 14, boxShadow: '0 1px 4px rgba(20,30,24,.07)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div style={{ fontSize: 15.5, fontWeight: 800 }}>Revenue by lead source</div>
            <div style={{ fontSize: 13, color: GREEN, fontWeight: 800 }}>{money(revenueBySource.grand)} collected</div>
          </div>
          <div style={{ fontSize: 12, color: '#9aa69e', marginBottom: 12 }}>Paid invoices (incl. tips), matched to the customer's lead source.</div>
          {revenueBySource.rows.length === 0 && <div style={{ color: '#7c8a82', fontSize: 13.5 }}>No paid invoices on this line yet.</div>}
          {revenueBySource.rows.map((r) => (
            <div key={r.key || 'unset'} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, marginBottom: 4 }}>
                <span style={{ fontWeight: 700 }}>{r.label} <span style={{ color: '#9aa69e', fontWeight: 400 }}>· {r.count} paid</span></span>
                <span style={{ fontWeight: 800 }}>{money(r.total)} <span style={{ color: '#9aa69e', fontWeight: 400 }}>({Math.round((r.total / Math.max(1, revenueBySource.grand)) * 100)}%)</span></span>
              </div>
              <div style={{ height: 9, borderRadius: 5, background: '#eef2ee' }}>
                <div style={{ height: 9, borderRadius: 5, background: r.key === 'web_form' ? GREEN : '#7fb89d', width: `${Math.max(2, (r.total / maxRev) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
