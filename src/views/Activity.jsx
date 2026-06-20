import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import { loadActivity, subscribeActivity } from '../lib/activityData.js'

const TYPE_META = {
  client_created: { glyph: '+', color: '#1f7a4d', bg: '#e7f1eb' },
  client_updated: { glyph: '✎', color: '#155e9c', bg: '#e7f0f9' },
  client_deleted: { glyph: '×', color: '#c0492f', bg: '#fdecea' },
  client_tagged: { glyph: '#', color: '#7a5cc0', bg: '#efeafb' },
  schedule_created: { glyph: '▤', color: '#1f7a4d', bg: '#e7f1eb' },
  invoice_created: { glyph: '$', color: '#b07a1e', bg: '#fdf2e0' },
  invoice_sent: { glyph: '➤', color: '#635bff', bg: '#efeafb' },
  invoice_paid: { glyph: '✓', color: '#1f7a4d', bg: '#e7f1eb' },
  invoice_deleted: { glyph: '×', color: '#c0492f', bg: '#fdecea' },
  stop_added: { glyph: '◔', color: '#155e9c', bg: '#e7f0f9' },
}
const fallback = { glyph: '•', color: '#7c8a82', bg: '#eef0ed' }

function relTime(iso) {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function dayLabel(iso) {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

export default function Activity({ app }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [search, setSearch] = useState('')
  const [who, setWho] = useState('all') // all | randy | you

  async function refresh() {
    const rows = await loadActivity(300)
    setEntries(rows)
  }

  useEffect(() => {
    if (!hasSupabase) {
      setErr('Supabase env vars not set — check .env.local')
      setLoading(false)
      return
    }
    refresh().catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
    let t
    const unsub = subscribeActivity(() => { clearTimeout(t); t = setTimeout(() => refresh().catch(() => {}), 250) })
    return () => { clearTimeout(t); unsub && unsub() }
  }, [])

  const q = search.toLowerCase().trim()
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (who === 'randy' && e.actor !== 'Trashy Randy') return false
      if (who === 'you' && e.actor === 'Trashy Randy') return false
      if (q && !(e.summary + ' ' + e.actor).toLowerCase().includes(q)) return false
      return true
    })
  }, [entries, q, who])

  // group by day
  const groups = useMemo(() => {
    const out = []
    let cur = null
    for (const e of filtered) {
      const label = dayLabel(e.createdAt)
      if (!cur || cur.label !== label) { cur = { label, items: [] }; out.push(cur) }
      cur.items.push(e)
    }
    return out
  }, [filtered])

  const WHO = [['all', 'Everyone'], ['randy', 'Trashy Randy'], ['you', 'You']]

  return (
    <div style={{ maxWidth: 820, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search activity…" style={searchInput} />
          <div style={searchIcon}>⌕</div>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          {WHO.map(([id, label]) => {
            const on = who === id
            return <button key={id} onClick={() => setWho(id)} style={{ background: on ? '#1f7a4d' : '#f3f5f2', color: on ? '#fff' : '#5d6b63', border: 'none', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{label}</button>
          })}
        </div>
      </div>

      {err && <div style={errorBox}>{err}</div>}
      {loading && <div style={empty}>Loading activity…</div>}

      {!loading && !entries.length && (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '44px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>◷</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 5 }}>No activity yet</div>
          <div style={{ fontSize: 13, color: '#7c8a82' }}>Actions you or Trashy Randy take — new clients, invoices, schedules, route stops — will show up here.</div>
        </div>
      )}

      {!loading && !!entries.length && !filtered.length && <div style={empty}>Nothing matches that filter.</div>}

      {groups.map((g) => (
        <div key={g.label} style={{ marginBottom: 18 }}>
          <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: '.1em', color: '#9aa69e', margin: '0 2px 8px' }}>{g.label.toUpperCase()}</div>
          <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden' }}>
            {g.items.map((e, i) => {
              const meta = TYPE_META[e.type] || fallback
              const isRandy = e.actor === 'Trashy Randy'
              return (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 15px', borderTop: i ? '1px solid #f1f3f0' : 'none' }}>
                  <div style={{ width: 30, height: 30, flex: 'none', borderRadius: 8, background: meta.bg, color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600 }}>{meta.glyph}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: '#1a2420' }}>{e.summary}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: isRandy ? '#7a5cc0' : '#5d6b63' }}>{isRandy ? '✦ Trashy Randy' : e.actor}</span>
                    </div>
                  </div>
                  <div style={{ flex: 'none', fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>{relTime(e.createdAt)}</div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

const empty = { padding: '22px 14px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }
const errorBox = { marginBottom: 14, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }
const searchInput = { width: '100%', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '9px 12px 9px 32px', fontSize: 16, outline: 'none', boxSizing: 'border-box' }
const searchIcon = { position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#9aa69e' }
