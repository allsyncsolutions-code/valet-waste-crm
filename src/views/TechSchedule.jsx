// "My Schedule" — a week/month calendar of upcoming jobs. Techs see the routes
// assigned to THEM; admins can flip to everyone's. Clicking a day shows that
// day's jobs (address, service, route, done state) under the calendar.
import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { loadScheduleRange } from '../lib/routesData.js'

const GREEN = '#1f7a4d'
const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY = iso(new Date())
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const parse = (s) => new Date(s + 'T12:00:00')
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d) }
const prettyDay = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })

// Sunday of the week containing `s`.
const weekStart = (s) => { const d = parse(s); d.setDate(d.getDate() - d.getDay()); return iso(d) }
const monthStart = (s) => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth(), 1)) }

export default function TechSchedule({ app }) {
  const me = app.user || {}
  const isAdmin = me.role === 'admin'
  const isMobile = app.isMobile

  const [mode, setMode] = useState('week') // week | month
  const [anchor, setAnchor] = useState(TODAY) // any date inside the visible range
  const [mineOnly, setMineOnly] = useState(!isAdmin) // admins may view everyone
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [selDay, setSelDay] = useState(TODAY)

  // Visible range.
  const range = useMemo(() => {
    if (mode === 'week') {
      const start = weekStart(anchor)
      return { start, end: addDays(start, 6) }
    }
    const ms = monthStart(anchor)
    const d = parse(ms)
    const end = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0))
    return { start: ms, end }
  }, [mode, anchor])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    loadScheduleRange(range.start, range.end, {
      driverId: mineOnly ? me.id : undefined,
      line: app.activeLine || undefined,
    })
      .then((r) => { if (alive) setRoutes(r) })
      .catch((e) => { if (alive) setErr(e.message || String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range.start, range.end, mineOnly, app.activeLine, me.id])

  // date -> flat list of jobs.
  const byDay = useMemo(() => {
    const m = {}
    for (const r of routes) {
      m[r.date] ||= []
      for (const s of r.stops) m[r.date].push({ ...s, route: r.code, routeName: r.name, driverId: r.driverId })
    }
    return m
  }, [routes])

  const step = (dir) => setAnchor((a) => addDays(a, dir * (mode === 'week' ? 7 : 30)))
  const rangeLabel = mode === 'week'
    ? `${parse(range.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${parse(range.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    : parse(range.start).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  // Days to render: week = 7; month = padded grid starting Sunday.
  const days = useMemo(() => {
    if (mode === 'week') return Array.from({ length: 7 }, (_, i) => addDays(range.start, i))
    const first = parse(range.start)
    const lead = first.getDay()
    const total = parse(range.end).getDate()
    const cells = []
    for (let i = 0; i < lead; i++) cells.push(null)
    for (let i = 1; i <= total; i++) cells.push(addDays(range.start, i - 1))
    while (cells.length % 7) cells.push(null)
    return cells
  }, [mode, range])

  const selJobs = byDay[selDay] || []
  const totalJobs = Object.values(byDay).reduce((s, l) => s + l.length, 0)

  return (
    <div style={{ maxWidth: 920, margin: '0 auto' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '9px 12px' }}>
        <div onClick={() => step(-1)} style={navBtn}>‹</div>
        <div style={{ fontWeight: 700, fontSize: 14, minWidth: 150, textAlign: 'center' }}>{rangeLabel}</div>
        <div onClick={() => step(1)} style={navBtn}>›</div>
        <div onClick={() => { setAnchor(TODAY); setSelDay(TODAY) }} style={{ fontSize: 12, fontWeight: 600, color: GREEN, border: '1px solid #cfe0d5', borderRadius: 8, padding: '6px 11px', cursor: 'pointer' }}>Today</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 5 }}>
          {['week', 'month'].map((m) => (
            <button key={m} onClick={() => setMode(m)} style={{ background: mode === m ? GREEN : '#fff', color: mode === m ? '#fff' : '#5d6b63', border: `1px solid ${mode === m ? GREEN : '#dde2dd'}`, borderRadius: 8, padding: '6px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>{m}</button>
          ))}
        </div>
        {isAdmin && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#5d6b63', cursor: 'pointer' }}>
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} style={{ accentColor: GREEN }} />
            My routes only
          </label>
        )}
      </div>

      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {/* calendar grid */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: 10, marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6, marginBottom: 6 }}>
          {DOW.map((d) => <div key={d} style={{ textAlign: 'center', fontFamily: MONO, fontSize: 10, color: '#9aa69e', letterSpacing: '.08em' }}>{d.toUpperCase()}</div>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
          {days.map((key, i) => {
            if (!key) return <div key={`x${i}`} />
            const jobs = byDay[key] || []
            const done = jobs.filter((j) => j.done).length
            const on = key === selDay
            const isToday = key === TODAY
            return (
              <div key={key} onClick={() => setSelDay(key)} style={{ minHeight: mode === 'week' ? 84 : 62, border: `1px solid ${on ? GREEN : isToday ? '#cfe0d5' : '#eef0ed'}`, background: on ? '#e7f1eb' : '#fff', borderRadius: 10, padding: '6px 7px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: isToday ? GREEN : '#3a463f' }}>{parse(key).getDate()}</div>
                {loading ? null : jobs.length > 0 ? (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 700, color: GREEN }}>{jobs.length} job{jobs.length === 1 ? '' : 's'}</div>
                    {done > 0 && <div style={{ fontSize: 10, color: '#7c8a82' }}>{done} done</div>}
                    {mode === 'week' && !isMobile && jobs.slice(0, 2).map((j) => (
                      <div key={j.id} style={{ fontSize: 10, color: '#7c8a82', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.address}</div>
                    ))}
                  </>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {/* selected day detail */}
      <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '16px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{prettyDay(selDay)}</div>
          <div style={{ fontSize: 12, color: '#7c8a82' }}>{selJobs.length} job{selJobs.length === 1 ? '' : 's'}{loading ? ' · loading…' : ''}</div>
          <div style={{ flex: 1 }} />
          {selJobs.length > 0 && <button onClick={() => app.go('myday')} style={{ background: 'none', border: 'none', color: GREEN, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>Open My Day ›</button>}
        </div>
        {!loading && selJobs.length === 0 && <div style={{ fontSize: 12.5, color: '#9aa69e' }}>Nothing scheduled this day.</div>}
        {selJobs.map((j) => (
          <div key={j.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 0', borderTop: '1px solid #f1f3f0', fontSize: 13 }}>
            <span style={{ flex: 'none', width: 16, textAlign: 'center', color: j.done ? GREEN : '#9aa69e' }}>{j.done ? '✓' : '○'}</span>
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.address || '—'}</span>
            <span style={{ flex: 'none', fontSize: 11.5, color: '#7c8a82' }}>{j.service}</span>
            <span style={{ flex: 'none', fontFamily: MONO, fontSize: 10.5, color: '#9aa69e' }}>Rt {j.route}</span>
          </div>
        ))}
        <div style={{ marginTop: 12, fontSize: 11.5, color: '#9aa69e' }}>{totalJobs} job{totalJobs === 1 ? '' : 's'} in this {mode} · {mineOnly ? 'your routes' : 'all routes'} · {app.activeLineObj?.name || ''}</div>
      </div>
    </div>
  )
}

const navBtn = { width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid #e6eae6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 15 }
