import { useEffect, useMemo, useState } from 'react'
import { MONO } from '../data.js'
import { STATUS_META } from '../lib/routeModel.js'
import { loadDayDispatch } from '../lib/routesData.js'
import { loadDrivers } from '../lib/teamData.js'
import { supabase } from '../lib/supabaseClient.js'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY = iso(new Date())
const pretty = (key) => {
  const d = new Date(key + 'T12:00:00')
  return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`
}
const addDays = (key, n) => {
  const d = new Date(key + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return iso(d)
}
function initialsOf(name) {
  return String(name || 'U').replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'U'
}

export default function Drivers({ app }) {
  const isMobile = app.isMobile
  const go = app.go

  const [date, setDate] = useState(TODAY)
  const [drivers, setDrivers] = useState([])
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [expanded, setExpanded] = useState({}) // driverId/route key -> bool

  async function refresh(d = date) {
    const [drv, rts] = await Promise.all([loadDrivers(), loadDayDispatch(d)])
    setDrivers(drv)
    setRoutes(rts)
  }

  useEffect(() => {
    setLoading(true)
    setErr(null)
    refresh(date).catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
  }, [date])

  // Live: any stop change on this day's routes refreshes the board.
  useEffect(() => {
    const ch = supabase
      .channel('dispatch-' + date)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'route_stops' }, () => refresh(date).catch(() => {}))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'routes' }, () => refresh(date).catch(() => {}))
      .subscribe()
    return () => { try { supabase.removeChannel(ch) } catch (e) {} }
  }, [date])

  // Group routes by driver.
  const byDriver = useMemo(() => {
    const m = new Map()
    for (const r of routes) {
      const k = r.driverId || '__none__'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return m
  }, [routes])

  const driverName = (d) => d.full_name || d.email
  const unassigned = byDriver.get('__none__') || []
  const activeDrivers = drivers.filter((d) => (byDriver.get(d.id) || []).length)
  const idleDrivers = drivers.filter((d) => !(byDriver.get(d.id) || []).length)

  function routeStats(rts) {
    const stops = rts.reduce((n, r) => n + r.stops.length, 0)
    const done = rts.reduce((n, r) => n + r.stops.filter((s) => s.status === 'done').length, 0)
    return { stops, done }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* date nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '9px 12px' }}>
        <div onClick={() => setDate((d) => addDays(d, -1))} style={navBtn}>‹</div>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
          {pretty(date)}{date === TODAY && <span style={{ marginLeft: 8, fontSize: 11, color: '#1f7a4d', fontFamily: MONO }}>TODAY</span>}
        </div>
        <div onClick={() => setDate((d) => addDays(d, 1))} style={navBtn}>›</div>
        {date !== TODAY && <div onClick={() => setDate(TODAY)} style={{ fontSize: 12, fontWeight: 600, color: '#1f7a4d', border: '1px solid #cfe0d5', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>Today</div>}
      </div>

      {err && <div style={banner('#c0492f', '#fbeae6')}>{err}</div>}

      {loading ? (
        <div style={{ color: '#7c8a82', fontSize: 13, padding: 28, textAlign: 'center' }}>Loading dispatch…</div>
      ) : (
        <>
          {/* on the road */}
          {activeDrivers.length === 0 && unassigned.length === 0 && (
            <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '34px 22px', textAlign: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>No routes for {pretty(date)} yet</div>
              <div style={{ fontSize: 13, color: '#7c8a82', marginBottom: 14 }}>Build a route and assign a driver to see the day's dispatch here.</div>
              <button onClick={() => go && go('routes')} style={primaryBtn}>Go to Routes &amp; Dispatch</button>
            </div>
          )}

          {activeDrivers.map((d) => {
            const rts = byDriver.get(d.id) || []
            const { stops, done } = routeStats(rts)
            const open = expanded[d.id]
            return (
              <div key={d.id} style={card}>
                <div onClick={() => setExpanded((e) => ({ ...e, [d.id]: !e[d.id] }))} style={{ display: 'flex', alignItems: 'center', gap: 13, cursor: 'pointer' }}>
                  <div style={avatar}>{initialsOf(driverName(d))}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{driverName(d)}</div>
                    <div style={{ fontSize: 12, color: '#7c8a82' }}>
                      {rts.map((r) => `${r.code} · ${r.name}`).join('  +  ')}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700 }}>{done}/{stops}</div>
                    <div style={{ fontSize: 10.5, color: '#9aa69e' }}>stops done</div>
                  </div>
                  <div style={{ color: '#9aa69e', fontSize: 13, width: 16, textAlign: 'center' }}>{open ? '▾' : '▸'}</div>
                </div>

                {open && rts.map((r) => (
                  <div key={r.id} style={{ marginTop: 12 }}>
                    {rts.length > 1 && <div style={{ fontFamily: MONO, fontSize: 11, color: '#7c8a82', margin: '6px 2px' }}>{r.code} · {r.name}</div>}
                    {r.stops.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#9aa69e', padding: '6px 2px' }}>No stops on this route.</div>
                    ) : r.stops.map((s) => <StopRow key={s.id} s={s} />)}
                  </div>
                ))}
              </div>
            )
          })}

          {/* unassigned routes */}
          {unassigned.length > 0 && (
            <div style={{ ...card, borderColor: '#e2cfa6', background: '#fdf8ef' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#9a7b1e' }}>Unassigned routes</div>
                  <div style={{ fontSize: 12, color: '#9a7b3e' }}>{unassigned.map((r) => `${r.code} · ${r.name} (${r.stops.length})`).join('  ·  ')}</div>
                </div>
                <button onClick={() => go && go('routes')} style={{ ...primaryBtn, background: '#c08a2e' }}>Assign a driver</button>
              </div>
            </div>
          )}

          {/* available drivers */}
          {idleDrivers.length > 0 && (
            <div style={card}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Available · no route {date === TODAY ? 'today' : 'this day'}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {idleDrivers.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e6eae6', borderRadius: 20, padding: '5px 11px 5px 6px' }}>
                    <div style={{ ...avatar, width: 26, height: 26, fontSize: 11 }}>{initialsOf(driverName(d))}</div>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{driverName(d)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {drivers.length === 0 && (
            <div style={{ fontSize: 12.5, color: '#9aa69e', textAlign: 'center', marginTop: 10 }}>
              No drivers yet — flag staff as drivers in the Team tab.
            </div>
          )}

          <div style={{ fontSize: 11.5, color: '#9aa69e', textAlign: 'center', marginTop: 18 }}>
            Check-in / check-out, photos and live GPS are coming to this tab next.
          </div>
        </>
      )}
    </div>
  )
}

function StopRow({ s }) {
  const meta = STATUS_META[s.status] || STATUS_META.pending
  return (
    <div style={{ display: 'flex', gap: 10, padding: '7px 4px', borderTop: '1px solid #f1f3f0', alignItems: 'center' }}>
      <div style={{ width: 22, height: 22, flex: 'none', borderRadius: '50%', background: meta.bg, color: meta.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 10.5, fontWeight: 600 }}>{s.seq}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
        <div style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address || s.service}</div>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: meta.color, flex: 'none' }}>{meta.label}</div>
      {s.lat != null && s.lng != null && (
        <a href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, fontWeight: 600, color: '#1f7a4d', textDecoration: 'none', flex: 'none' }} title="Navigate">➤</a>
      )}
    </div>
  )
}

const navBtn = { width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid #e6eae6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 15 }
const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '14px 16px', marginBottom: 12 }
const avatar = { width: 42, height: 42, flex: 'none', borderRadius: '50%', background: '#3a5246', color: '#dff0e6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 14 }
const primaryBtn = { background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const banner = (color, bg) => ({ background: bg, color, border: `1px solid ${color}33`, borderRadius: 10, padding: '12px 14px', fontSize: 13, marginBottom: 14 })
