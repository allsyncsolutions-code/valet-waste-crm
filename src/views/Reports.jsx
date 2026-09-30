// Reports — where customers come from. Lead-source breakdown of the customer
// base for the active business line: all-time counts plus new signups in the
// last 90 days, so the team can see which channels are actually producing.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { LEAD_SOURCES, leadSourceLabel } from '../lib/leadSources.js'

const GREEN = '#1f7a4d'
const RECENT_MS = 90 * 86400000

export default function Reports({ app }) {
  const line = app.activeLine || 'waste'
  const [rows, setRows] = useState(null)
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
    </div>
  )
}
