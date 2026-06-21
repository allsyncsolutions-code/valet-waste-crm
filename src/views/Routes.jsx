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
  loadActiveSchedules,
  scheduleHitsDate,
  assignDriver,
  getRouteDefault,
  setRouteDefault,
  addOneOffStop,
  loadRouteDefs,
  createRouteDef,
  copyPreviousWeekday,
  moveStopToRoute,
  ensureRoute,
} from '../lib/routesData.js'
import { loadDrivers } from '../lib/teamData.js'
import { loadCustomers } from '../lib/customersData.js'
import { createInvoice } from '../lib/invoicesData.js'

const BLANK_STOP = { name: '', address: '', service: '', customerId: '', customerName: '', description: '', price: '' }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY_KEY = iso(new Date())
const prettyDate = (key) => {
  const d = new Date(key + 'T12:00:00')
  return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`
}

export default function RoutesView({ app }) {
  const isMobile = app.isMobile
  const [routeSel, setRouteSel] = useState(TODAY_KEY)
  const [weekOffset, setWeekOffset] = useState(0)
  const [routeDefs, setRouteDefs] = useState([]) // catalog of routes (A/B/C…)
  const [routeCode, setRouteCode] = useState('B') // which route is being viewed

  const [route, setRoute] = useState(null)
  const [depot, setDepot] = useState(FALLBACK_DEPOT)
  const [stops, setStops] = useState([])
  const [unrouted, setUnrouted] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [optimized, setOptimized] = useState(false)
  const [saved, setSaved] = useState(null)

  const [schedules, setSchedules] = useState([]) // active schedules, for the day dots
  const [drivers, setDrivers] = useState([]) // staff flagged is_driver
  const [defaultDriverId, setDefaultDriverId] = useState(null) // carry-forward default

  const baselineRef = useRef(null) // metrics of the first-loaded order
  const writingRef = useRef(false) // suppress realtime reload during our own writes

  async function refresh(date = routeSel) {
    const slice = await loadRouteSlice(routeCode, date)
    setRoute(slice.route)
    setDepot(slice.depot)
    setStops(slice.stops)
    setUnrouted(slice.unrouted)
    baselineRef.current = routeMetrics(slice.stops, slice.depot)
    return slice
  }

  // Load the selected date's route (re-runs whenever the date changes).
  useEffect(() => {
    let alive = true
    if (!hasSupabase) {
      setErr('Supabase env vars not set — check .env.local')
      setLoading(false)
      return
    }
    setLoading(true)
    setSaved(null)
    setOptimized(false)
    refresh(routeSel)
      .catch((e) => alive && setErr(e.message || String(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [routeSel, routeCode])

  // Active schedules drive the "service day" dots in the picker; load the
  // driver list and the route catalog once.
  useEffect(() => {
    loadActiveSchedules().then(setSchedules).catch(() => {})
    loadDrivers().then(setDrivers).catch(() => {})
    loadRouteDefs().then((defs) => {
      setRouteDefs(defs)
      if (defs.length && !defs.some((d) => d.code === routeCode)) setRouteCode(defs[0].code)
    }).catch(() => {})
  }, [])

  // Track the carry-forward default driver of whichever route is selected.
  useEffect(() => {
    getRouteDefault(routeCode).then(setDefaultDriverId).catch(() => {})
  }, [routeCode])

  // Change the driver assigned to the selected date's route.
  async function handleDriverChange(e) {
    const driverId = e.target.value || null
    setErr(null)
    try {
      await assignDriver(routeCode, routeSel, driverId)
      await refresh(routeSel)
    } catch (e2) { setErr(e2.message || String(e2)) }
  }

  // Toggle "remember this driver as the default for new days".
  async function handleDefaultToggle(e) {
    const on = e.target.checked
    const driverId = route?.driver_id || null
    setErr(null)
    try {
      await setRouteDefault(routeCode, on ? driverId : null)
      setDefaultDriverId(on ? driverId : null)
    } catch (e2) { setErr(e2.message || String(e2)) }
  }

  const assignedDriverId = route?.driver_id || ''
  const isDefault = !!defaultDriverId && defaultDriverId === (route?.driver_id || null)
  const currentDef = routeDefs.find((d) => d.code === routeCode) || { code: routeCode, name: `Route ${routeCode}` }

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
      const r = route || await ensureRoute(routeCode, routeSel) // create the route for this date if needed
      await addStopToRoute(r.id, propStop, seq)
      await refresh()
    })
  }

  // ---- one-off pickup modal ----
  const [showNewStop, setShowNewStop] = useState(false)
  const [newStop, setNewStop] = useState(BLANK_STOP)
  const [savingStop, setSavingStop] = useState(false)
  const [customers, setCustomers] = useState([])
  const [custOpen, setCustOpen] = useState(false)

  function openNewStop() {
    setNewStop(BLANK_STOP)
    setCustOpen(false)
    setShowNewStop(true)
  }

  // Open the modal when the top-bar "+ New pickup" button bumps the tick.
  const pickupTickRef = useRef(app.newPickupTick)
  useEffect(() => {
    if (app.newPickupTick !== pickupTickRef.current) {
      pickupTickRef.current = app.newPickupTick
      openNewStop()
    }
  }, [app.newPickupTick])

  // Load the customer list the first time the modal is opened.
  useEffect(() => {
    if (showNewStop && customers.length === 0) {
      loadCustomers().then(setCustomers).catch(() => {})
    }
  }, [showNewStop])

  async function submitNewStop(e) {
    e.preventDefault()
    if (savingStop) return
    const addr = newStop.address.trim()
    if (!addr) { setErr('Enter an address for the pickup.'); return }

    // Resolve the customer (allow a typed exact-name match too).
    let custId = newStop.customerId
    if (!custId && newStop.customerName.trim()) {
      const m = customers.find((c) => c.name.toLowerCase() === newStop.customerName.trim().toLowerCase())
      if (m) custId = m.id
    }
    if (!custId) { setErr('Pick a customer from the list to tie this pickup to.'); return }

    const price = parseFloat(newStop.price)
    const hasPrice = !isNaN(price) && price > 0

    setSavingStop(true)
    setErr(null)
    try {
      const res = await addOneOffStop(routeCode, routeSel, {
        name: newStop.name, address: addr, service: newStop.service, customerId: custId, price: hasPrice ? price : null,
      })
      if (hasPrice) {
        await createInvoice({
          customerId: custId,
          status: 'draft',
          items: [{
            description: (newStop.description || '').trim() || newStop.service.trim() || 'One-off pickup',
            quantity: 1,
            unitPrice: price,
          }],
        })
      }
      setShowNewStop(false)
      setNewStop(BLANK_STOP)
      await refresh(routeSel)
      if (!res.geocoded) {
        setErr("Added to the route, but I couldn't locate that address on the map — double-check the address if it should appear as a pin.")
      }
    } catch (e2) {
      setErr(e2.message || String(e2))
    }
    setSavingStop(false)
  }

  const [building, setBuilding] = useState(false)
  async function handleBuildFromSchedules() {
    if (building) return
    setBuilding(true)
    setErr(null)
    try {
      const res = await buildRouteFromSchedules(routeCode, routeSel)
      if (res.noSchedules) setErr(`No pickups are scheduled for ${prettyDate(routeSel)}. Pick a date that matches a client's schedule.`)
      await refresh(routeSel)
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBuilding(false)
    }
  }

  const selDow = DOW[new Date(routeSel + 'T12:00:00').getDay()]

  const [copying, setCopying] = useState(false)
  async function handleCopyPrevious() {
    if (copying) return
    setCopying(true)
    setErr(null)
    try {
      const res = await copyPreviousWeekday(routeCode, routeSel)
      if (res.noSource) setErr(`No earlier ${selDow} found for ${currentDef.name} to copy from.`)
      else if (res.copied === 0) setErr(`Nothing new to copy — those stops are already on ${prettyDate(routeSel)}.`)
      await refresh(routeSel)
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setCopying(false)
    }
  }

  async function addRoute() {
    const name = window.prompt('New route name (e.g. "Route C" or "North Side")')
    if (name == null || !name.trim()) return
    const used = new Set(routeDefs.map((r) => r.code))
    let suggested = ''
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (!used.has(ch)) { suggested = ch; break } }
    const code = window.prompt('Short route code (1–3 characters)', suggested || (name.trim()[0] || 'R').toUpperCase())
    if (code == null || !code.trim()) return
    setErr(null)
    try {
      const def = await createRouteDef({ code, name })
      setRouteDefs(await loadRouteDefs())
      setRouteCode(def.code)
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  function handleMoveToRoute(stopId, targetCode) {
    if (!targetCode) return
    setStops((prev) => prev.filter((s) => s.id !== stopId)) // optimistic
    setErr(null)
    withWrite(async () => {
      await moveStopToRoute(stopId, targetCode, routeSel)
      await refresh(routeSel)
    })
  }

  // ---- day picker (real dates; dots mark days with a scheduled pickup) ----
  const todayD = new Date()
  const base = new Date(todayD.getFullYear(), todayD.getMonth(), todayD.getDate() - todayD.getDay() + 1 + weekOffset * 7) // Monday of the week
  const days = []
  for (let i = 0; i < 7; i++) {
    const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
    const key = iso(dt)
    const selected = key === routeSel
    const isToday = key === TODAY_KEY
    const hasStops = schedules.some((s) => scheduleHitsDate(s, key))
    days.push({
      key, dow: DOW[dt.getDay()], day: String(dt.getDate()), selected, hasStops,
      stopDot: selected ? '#1f7a4d' : '#9fc7b1',
      border: selected ? '#1f7a4d' : isToday ? '#cfe0d5' : '#e6eae6',
      bg: selected ? '#e7f1eb' : '#fff',
      dowColor: selected ? '#1f7a4d' : '#9aa69e',
      dayColor: selected ? '#15281d' : isToday ? '#1f7a4d' : '#3a463f',
    })
  }
  const monthLabel = MON[base.getMonth()] + ' ' + base.getFullYear()

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

      {/* route selector (one tab per route; shows its driver) */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 12 }}>
        {routeDefs.map((rd) => {
          const sel = rd.code === routeCode
          const drv = drivers.find((d) => d.id === rd.driver_id)
          return (
            <div key={rd.code} onClick={() => setRouteCode(rd.code)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${sel ? '#1f7a4d' : '#e6eae6'}`, background: sel ? '#e7f1eb' : '#fff' }}>
              <div style={{ width: 26, height: 26, borderRadius: 7, background: sel ? '#1f7a4d' : '#7c8a82', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 12 }}>{rd.code}</div>
              <div style={{ lineHeight: 1.2 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: sel ? '#15281d' : '#3a463f' }}>{rd.name}</div>
                <div style={{ fontSize: 10.5, color: '#7c8a82' }}>{drv ? (drv.full_name || drv.email) : 'No default driver'}</div>
              </div>
            </div>
          )
        })}
        <div onClick={addRoute} title="Add a route" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 10, cursor: 'pointer', border: '1px dashed #cdd6cf', color: '#5d6b63', fontSize: 13, fontWeight: 600 }}>+ Add route</div>
      </div>

      {/* selected route: driver lives in the card; actions on the right */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ padding: '10px 14px', borderRadius: 12, border: '1px solid #cfe0d5', background: '#f3faf5', minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: '#1f7a4d', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 13 }}>{currentDef.code}</div>
            <div style={{ lineHeight: 1.25 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{currentDef.name}</div>
              <div style={{ fontSize: 10.5, color: '#7c8a82' }}>{prettyDate(routeSel)} · {stops.length} stop{stops.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          {drivers.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontFamily: MONO, color: '#7c8a82' }}>🚛</span>
              <select value={assignedDriverId} onChange={handleDriverChange} style={{ flex: 1, minWidth: 130, border: '1px solid #dde2dd', background: '#fff', borderRadius: 8, padding: '7px 9px', fontSize: 13, color: '#1a2420', outline: 'none', fontWeight: 600 }}>
                <option value="">— Unassigned —</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>{d.full_name || d.email}</option>
                ))}
              </select>
              <label title={assignedDriverId ? `Auto-assign to new ${currentDef.code} routes` : 'Assign a driver first'} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#5d6b63', cursor: assignedDriverId ? 'pointer' : 'not-allowed', opacity: assignedDriverId ? 1 : 0.5 }}>
                <input type="checkbox" checked={isDefault} disabled={!assignedDriverId} onChange={handleDefaultToggle} style={{ width: 14, height: 14, accentColor: '#1f7a4d', cursor: 'inherit' }} />
                Default
              </label>
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: '#9aa69e', fontStyle: 'italic', marginTop: 10 }}>No drivers yet — flag staff as drivers in Team.</div>
          )}
        </div>

        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={openNewStop} style={ghostBtn}>+ New pickup</button>
          <button onClick={handleCopyPrevious} disabled={copying} style={{ ...ghostBtn, opacity: copying ? 0.6 : 1 }}>{copying ? 'Copying…' : `Copy last ${selDow}`}</button>
          <button onClick={handleBuildFromSchedules} disabled={building} style={{ ...ghostBtn, opacity: building ? 0.6 : 1 }}>{building ? 'Building…' : 'Build from schedules'}</button>
          <button onClick={() => refresh().catch((e) => setErr(e.message))} style={ghostBtn}>Reload</button>
          <button onClick={handleOptimize} disabled={loading || !stops.length} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'linear-gradient(135deg,#1f7a4d,#155e3a)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: loading ? 'default' : 'pointer', opacity: loading || !stops.length ? 0.6 : 1 }}>
            <span>✦</span> Optimize
          </button>
        </div>
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
                        {routeDefs.length > 1 && (
                          <select value="" onChange={(e) => handleMoveToRoute(st.id, e.target.value)} title="Move to another route (hands it to that route's driver)" style={{ ...miniBtn, paddingRight: 4, cursor: 'pointer' }}>
                            <option value="">→ Route…</option>
                            {routeDefs.filter((rd) => rd.code !== routeCode).map((rd) => (
                              <option key={rd.code} value={rd.code}>{rd.code} · {rd.name}</option>
                            ))}
                          </select>
                        )}
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
      {/* one-off pickup modal */}
      {showNewStop && (
        <div onClick={() => !savingStop && setShowNewStop(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, padding: 16 }}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submitNewStop} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 440, maxWidth: '100%', boxShadow: '0 24px 60px rgba(15,30,20,.28)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 16, flex: 1 }}>New one-off pickup</div>
              <div onClick={() => !savingStop && setShowNewStop(false)} style={{ cursor: 'pointer', color: '#7c8a82', fontSize: 18 }}>✕</div>
            </div>
            <div style={{ fontSize: 12.5, color: '#7c8a82', marginBottom: 16 }}>
              Adds a single stop to Route {routeCode} on <b>{prettyDate(routeSel)}</b> only — no recurring schedule. Add a price to also create a draft invoice for the customer.
            </div>

            {/* customer combobox */}
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <label style={mLbl}>Customer</label>
              <input
                value={newStop.customerName}
                onChange={(e) => { setNewStop({ ...newStop, customerName: e.target.value, customerId: '' }); setCustOpen(true) }}
                onFocus={() => setCustOpen(true)}
                style={mInp}
                placeholder="Search your customers…"
                autoComplete="off"
              />
              {newStop.customerId && <div style={{ position: 'absolute', right: 11, top: 35, color: '#1f7a4d', fontSize: 14 }}>✓</div>}
              {custOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, background: '#fff', border: '1px solid #dde2dd', borderRadius: 9, marginTop: 4, maxHeight: 184, overflowY: 'auto', boxShadow: '0 12px 28px rgba(15,30,20,.14)' }}>
                  {customers.length === 0 && <div style={{ padding: '9px 11px', fontSize: 12, color: '#9aa69e' }}>Loading customers…</div>}
                  {customers
                    .filter((c) => !newStop.customerName.trim() || c.name.toLowerCase().includes(newStop.customerName.trim().toLowerCase()))
                    .slice(0, 40)
                    .map((c) => (
                      <div key={c.id} onClick={() => { setNewStop((s) => ({ ...s, customerId: c.id, customerName: c.name, address: s.address || c.address || '' })); setCustOpen(false) }} style={{ padding: '8px 11px', cursor: 'pointer', borderBottom: '1px solid #f1f3f0' }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
                        {c.address && <div style={{ fontSize: 11, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.address}</div>}
                      </div>
                    ))}
                  {customers.length > 0 && customers.filter((c) => !newStop.customerName.trim() || c.name.toLowerCase().includes(newStop.customerName.trim().toLowerCase())).length === 0 && (
                    <div style={{ padding: '9px 11px', fontSize: 12, color: '#9aa69e' }}>No match — add the client in Clients first.</div>
                  )}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={mLbl}>Address</label>
              <input value={newStop.address} onChange={(e) => setNewStop({ ...newStop, address: e.target.value })} onFocus={() => setCustOpen(false)} style={mInp} placeholder="123 Main St, St. Augustine, FL 32084" />
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={mLbl}>Name / label <span style={{ color: '#9aa69e', fontWeight: 400 }}>(optional)</span></label>
                <input value={newStop.name} onChange={(e) => setNewStop({ ...newStop, name: e.target.value })} style={mInp} placeholder="Defaults to the address" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={mLbl}>Service <span style={{ color: '#9aa69e', fontWeight: 400 }}>(optional)</span></label>
                <input value={newStop.service} onChange={(e) => setNewStop({ ...newStop, service: e.target.value })} style={mInp} placeholder="e.g. Trash / Recycle" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 2 }}>
                <label style={mLbl}>Charge description <span style={{ color: '#9aa69e', fontWeight: 400 }}>(for the invoice)</span></label>
                <input value={newStop.description} onChange={(e) => setNewStop({ ...newStop, description: e.target.value })} style={mInp} placeholder="Defaults to the service / “One-off pickup”" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={mLbl}>Price <span style={{ color: '#9aa69e', fontWeight: 400 }}>(optional)</span></label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#7c8a82', fontSize: 15 }}>$</span>
                  <input value={newStop.price} onChange={(e) => setNewStop({ ...newStop, price: e.target.value })} inputMode="decimal" style={{ ...mInp, paddingLeft: 22 }} placeholder="0.00" />
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setShowNewStop(false)} disabled={savingStop} style={ghostBtn}>Cancel</button>
              <button type="submit" disabled={savingStop} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: savingStop ? 0.7 : 1 }}>{savingStop ? 'Adding…' : 'Add to route'}</button>
            </div>
          </form>
        </div>
      )}
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
const mLbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#5d6b63', marginBottom: 6 }
const mInp = { width: '100%', boxSizing: 'border-box', border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '10px 12px', fontSize: 15, color: '#1a2420', outline: 'none' }
