import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import RouteMap from '../components/RouteMap.jsx'
import {
  DEPOT as FALLBACK_DEPOT,
  STATUS_META,
  resequence,
  splitFixed,
  moveStop,
  removeStop as removeLocal,
  addStop as addLocal,
  isFixed,
} from '../lib/routeModel.js'
import { optimizeOrder, routeMetrics } from '../lib/optimize.js'
import { formatMiles, formatDuration, metersToMiles } from '../lib/geo.js'
import { hasSupabase } from '../lib/supabaseClient.js'
import {
  loadRouteSlice,
  persistOrder,
  addStopToRoute,
  removeStopFromRoute,
  subscribeRouteStops,
  buildRouteFromSchedules,
} from '../lib/routesData.js'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TODAY_KEY = '2026-6-19'
const ROUTE_CODE = 'B'

export default function RoutesView({ app }) {
  const isMobile = app.isMobile
  const [routeSel, setRouteSel] = useState(TODAY_KEY)
  const [weekOffset, setWeekOffset] = useState(0)

  const [route, setRoute] = useState(null)
  const [depot, setDepot] = useState(FALLBACK_DEPOT)
  const [stops, setStops] = useState([])
  const [unrouted, setUnrouted] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [optimized, setOptimized] = useState(false)
  const [saved, setSaved] = useState(null)

  const baselineRef = useRef(null) // metrics of the first-loaded order
  const writingRef = useRef(false) // suppress realtime reload during our own writes

  async function refresh() {
    const slice = await loadRouteSlice(ROUTE_CODE)
    setRoute(slice.route)
    setDepot(slice.depot)
    setStops(slice.stops)
    setUnrouted(slice.unrouted)
    if (!baselineRef.current) baselineRef.current = routeMetrics(slice.stops, slice.depot)
    return slice
  }

  // Initial load.
  useEffect(() => {
    let alive = true
    if (!hasSupabase) {
      setErr('Supabase env vars not set — check .env.local')
      setLoading(false)
      return
    }
    refresh()
      .catch((e) => alive && setErr(e.message || String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  // Live updates: reload when another client (or driver) changes this route.
  useEffect(() => {
    if (!route?.id) return
    let t
    const unsub = subscribeRouteStops(route.id, () => {
      if (writingRef.current) return // ignore echoes of our own writes
      clearTimeout(t)
      t = setTimeout(() => refresh().catch(() => {}), 350)
    })
    return () => {
      clearTimeout(t)
      unsub()
    }
  }, [route?.id])

  const current = routeMetrics(stops, depot)
  const baseline = baselineRef.current || current

  function optimizeStart() {
    const { fixed } = splitFixed(stops)
    return fixed.length ? fixed[fixed.length - 1] : depot
  }

  async function withWrite(fn) {
    writingRef.current = true
    try {
      await fn()
    } catch (e) {
      setErr(e.message || String(e))
      refresh().catch(() => {})
    } finally {
      setTimeout(() => (writingRef.current = false), 500)
    }
  }

  function handleOptimize() {
    const before = routeMetrics(stops, depot)
    const { fixed, movable } = splitFixed(stops)
    const { ordered } = optimizeOrder(movable, optimizeStart())
    const next = resequence([...fixed, ...ordered])
    setStops(next)
    const after = routeMetrics(next, depot)
    setSaved({
      miles: Math.max(0, metersToMiles(before.meters - after.meters)),
      minutes: Math.max(0, before.minutes - after.minutes),
    })
    setOptimized(true)
    withWrite(() => persistOrder(next))
  }

  function handleMove(id, dir) {
    const next = moveStop(stops, id, dir)
    setStops(next)
    setOptimized(false)
    withWrite(() => persistOrder(next))
  }

  function handleRemove(id) {
    const stop = stops.find((s) => s.id === id)
    if (!stop || isFixed(stop)) return
    const next = removeLocal(stops, id)
    setStops(next)
    setUnrouted((u) => [...u, { ...stop, id: `prop:${stop.propertyId}`, seq: undefined, status: 'pending' }])
    setOptimized(false)
    withWrite(async () => {
      await removeStopFromRoute(id)
      await persistOrder(next)
    })
  }

  function handleAdd(propStop) {
    const seq = stops.length + 1
    setUnrouted((u) => u.filter((s) => s.id !== propStop.id))
    setStops((s) => addLocal(s, propStop))
    setOptimized(false)
    withWrite(async () => {
      await addStopToRoute(route.id, propStop, seq)
      await refresh()
    })
  }

  const [building, setBuilding] = useState(false)
  async function handleBuildFromSchedules() {
    if (building) return
    setBuilding(true)
    setErr(null)
    try {
      const res = await buildRouteFromSchedules(ROUTE_CODE)
      if (res.noSchedules) setErr('No active pickup schedules yet — add one on the Schedules tab first.')
      baselineRef.current = null
      await refresh()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBuilding(false)
    }
  }

  // ---- day picker (cosmetic) ----
  const weekStart = new Date(2026, 5, 15 + weekOffset * 7)
  const days = []
  for (let i = 0; i < 7; i++) {
    const dt = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i)
    const key = dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate()
    const selected = key === routeSel
    const isToday = key === TODAY_KEY
    const hasStops = dt.getDay() >= 1 && dt.getDay() <= 6
    days.push({
      key, dow: DOW[dt.getDay()], day: String(dt.getDate()), selected, hasStops,
      stopDot: selected ? '#1f7a4d' : '#9fc7b1',
      border: selected ? '#1f7a4d' : isToday ? '#cfe0d5' : '#e6eae6',
      bg: selected ? '#e7f1eb' : '#fff',
      dowColor: selected ? '#1f7a4d' : '#9aa69e',
      dayColor: selected ? '#15281d' : isToday ? '#1f7a4d' : '#3a463f',
    })
  }
  const monthLabel = MON[weekStart.getMonth()] + ' ' + weekStart.getFullYear()

  const doneCount = stops.filter((s) => s.status === 'done').length

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      {/* day picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '9px 11px' }}>
        <div onClick={() => setWeekOffset((o) => o - 1)} style={navBtn}>‹</div>
        {!isMobile && <div style={{ width: 78, flex: 'none', fontFamily: MONO, fontSize: 12, color: '#5d6b63', textAlign: 'center' }}>{monthLabel}</div>}
        <div style={{ flex: 1, display: 'flex', gap: 6 }}>
          {days.map((d) => (
            <div key={d.key} onClick={() => setRouteSel(d.key)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '7px 4px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${d.border}`, background: d.bg }}>
              <div style={{ fontSize: 10, fontFamily: MONO, color: d.dowColor }}>{d.dow}</div>
              <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: d.dayColor }}>{d.day}</div>
              <div style={{ height: 5, display: 'flex', alignItems: 'center' }}>{d.hasStops && <div style={{ width: 5, height: 5, borderRadius: '50%', background: d.stopDot }} />}</div>
            </div>
          ))}
        </div>
        <div onClick={() => setWeekOffset((o) => o + 1)} style={navBtn}>›</div>
        {!isMobile && <div onClick={() => { setWeekOffset(0); setRouteSel(TODAY_KEY) }} style={{ flex: 'none', fontSize: 12, fontWeight: 600, color: '#1f7a4d', border: '1px solid #cfe0d5', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>Today</div>}
      </div>

      {/* route header + optimize */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {route && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px', borderRadius: 10, border: '1px solid #cfe0d5', background: '#f3faf5' }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: '#1f7a4d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12 }}>{route.code || '•'}</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{route.name || 'Route'}</div>
              {route.driver && <div style={{ fontSize: 10.5, color: '#7c8a82' }}>{route.driver}</div>}
            </div>
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => refresh().catch((e) => setErr(e.message))} style={ghostBtn}>Reload</button>
        <button onClick={handleBuildFromSchedules} disabled={building} style={{ ...ghostBtn, opacity: building ? 0.6 : 1 }}>{building ? 'Building…' : 'Build from schedules'}</button>
        <button onClick={handleOptimize} disabled={loading || !stops.length} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: loading ? 'default' : 'pointer', opacity: loading || !stops.length ? 0.6 : 1 }}>
          <span>✦</span> Optimize route
        </button>
      </div>

      {/* metrics bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14, background: '#15281d', color: '#dff0e6', borderRadius: 13, padding: '12px 16px' }}>
        <Metric label="Distance" value={formatMiles(current.meters)} />
        <Divider />
        <Metric label="Est. time" value={formatDuration(current.minutes)} />
        <Divider />
        <Metric label="Stops" value={`${stops.length}`} sub={`${doneCount} done`} />
        <div style={{ flex: 1 }} />
        {optimized && saved && (
          <div style={{ background: '#1f7a4d', borderRadius: 9, padding: '7px 13px', fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>
            ▼ saved {saved.miles.toFixed(1)} mi · {formatDuration(saved.minutes)} vs original
          </div>
        )}
        {!optimized && (
          <div style={{ fontFamily: MONO, fontSize: 11, color: '#7fb89a' }}>
            {loading ? 'loading route…' : 'est. via straight-line heuristic — swap in Mapbox/OSRM for road-accurate'}
          </div>
        )}
      </div>

      {err && (
        <div style={{ marginBottom: 14, background: '#fdecea', border: '1px solid #f3b7b0', color: '#9a2c1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5 }}>
          {err}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.4fr 1fr', gap: 16 }}>
        {/* MAP */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, overflow: 'hidden', minHeight: 300 }}>
          <RouteMap depot={depot} stops={stops} height={isMobile ? 320 : 520} />
        </div>

        {/* STOP SEQUENCE */}
        <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '6px 4px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px 8px' }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Stop sequence</div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: '#7c8a82' }}>{stops.length} stops</div>
          </div>
          <div style={{ maxHeight: isMobile ? 'none' : 560, overflowY: 'auto', padding: '0 6px' }}>
            {!loading && !stops.length && (
              <div style={{ padding: '28px 16px', textAlign: 'center', color: '#9aa69e', fontSize: 12.5 }}>
                {route ? 'No stops on this route yet.' : 'No route scheduled — add properties and a route to get started.'}
              </div>
            )}
            {stops.map((st) => {
              const meta = STATUS_META[st.status] || STATUS_META.pending
              const locked = isFixed(st)
              return (
                <div key={st.id} style={{ display: 'flex', gap: 10, padding: '7px 8px', borderBottom: '1px solid #f1f3f0' }}>
                  <div style={{ width: 24, height: 24, flex: 'none', borderRadius: '50%', background: meta.bg, color: meta.fg, border: st.status === 'enroute' ? '2px solid #46c585' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 11, fontWeight: 600 }}>{st.seq}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{st.name}</div>
                        <div style={{ fontSize: 11.5, color: '#7c8a82' }}>{st.service}</div>
                      </div>
                      <div style={{ textAlign: 'right', flex: 'none' }}>
                        <div style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 600, color: meta.color }}>{meta.label}</div>
                        <div style={{ fontSize: 10.5, color: '#9aa69e' }}>{st.window}</div>
                      </div>
                    </div>
                    {!locked && (
                      <div style={{ marginTop: 7, display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button onClick={() => handleMove(st.id, -1)} style={miniBtn} title="Move up">↑</button>
                        <button onClick={() => handleMove(st.id, 1)} style={miniBtn} title="Move down">↓</button>
                        <a href={`https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}`} target="_blank" rel="noreferrer" style={{ ...miniBtn, textDecoration: 'none', color: '#1f7a4d' }} title="Navigate">➤ Nav</a>
                        <div style={{ flex: 1 }} />
                        <button onClick={() => handleRemove(st.id)} style={{ ...miniBtn, color: '#c0492f' }} title="Remove from route">×</button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* unrouted / add */}
          {unrouted.length > 0 && (
            <div style={{ padding: '10px 12px 4px' }}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#b07a1e', marginBottom: 7 }}>UNROUTED ({unrouted.length})</div>
              {unrouted.map((st) => (
                <div key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', border: '1px dashed #e2cfa6', borderRadius: 9, marginBottom: 7, background: '#fdf8ef' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{st.name}</div>
                    <div style={{ fontSize: 11, color: '#9a7b3e' }}>{st.service}{st.window ? ` · ${st.window}` : ''}</div>
                  </div>
                  <button onClick={() => handleAdd(st)} style={{ flex: 'none', background: '#c08a2e', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 11px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>+ Add</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: '#7fb89a' }}>{label}{sub ? ` · ${sub}` : ''}</div>
    </div>
  )
}
const Divider = () => <div style={{ width: 1, height: 28, background: '#2c4435' }} />

const navBtn = { width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid #e6eae6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 15 }
const ghostBtn = { background: '#fff', color: '#5d6b63', border: '1px solid #e6eae6', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const miniBtn = { background: '#f3f5f2', border: '1px solid #e6eae6', borderRadius: 6, padding: '3px 8px', fontSize: 11.5, fontWeight: 600, color: '#5d6b63', cursor: 'pointer', lineHeight: 1.4 }
