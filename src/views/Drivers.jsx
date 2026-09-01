import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { STATUS_META } from '../lib/routeModel.js'
import { loadDayDispatch, checkInStop, checkOutStop, resetStopStatus, flagStopExcess, unflagStopExcess, markStopNudged, skipStop, unskipStop, loadRouteDefs, buildRouteFromSchedules, loadRouteCombos, createRouteCombo, updateRouteComboDrivers, deleteRouteCombo, groupRoutesByCombo } from '../lib/routesData.js'
import { loadStopPhotos, deleteStopPhoto } from '../lib/photosData.js'
import { loadDrivers } from '../lib/teamData.js'
import { logActivity, currentActorName } from '../lib/activityData.js'
import { supabase } from '../lib/supabaseClient.js'
import { queuePhoto } from '../lib/photoOutbox.js'
import usePhotoOutbox from '../usePhotoOutbox.js'

// Best-effort browser geolocation — resolves null if unavailable/denied.
function getGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 },
    )
  })
}
const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')

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

// Also renders EMBEDDED inside Routes & Dispatch ("Field" mode): pass `date`
// + `onDateChange` to control the day from outside and `embedded` to hide the
// built-in date nav (the Routes day picker drives it instead).
export default function Drivers({ app, date: dateProp, onDateChange, embedded }) {
  const isMobile = app.isMobile
  const go = app.go

  const [dateState, setDateState] = useState(TODAY)
  const date = dateProp || dateState
  const setDate = (next) => {
    const v = typeof next === 'function' ? next(date) : next
    if (onDateChange) onDateChange(v)
    else setDateState(v)
  }
  const [drivers, setDrivers] = useState([])
  const [routes, setRoutes] = useState([])
  const [routeDefs, setRouteDefs] = useState([]) // this line's route catalog (A/B/C…) — drives the route picker
  const [routeFilter, setRouteFilter] = useState('all') // 'all' | route code
  const [combos, setCombos] = useState([]) // day-scoped route combinations
  const [comboOpen, setComboOpen] = useState(false)
  const [comboCodes, setComboCodes] = useState({}) // code -> bool
  const [comboDrivers, setComboDrivers] = useState({}) // driverId -> bool
  const [comboBusy, setComboBusy] = useState(false)
  const [building, setBuilding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [expanded, setExpanded] = useState({}) // driverId/route key -> bool
  const [busyStop, setBusyStop] = useState(null)
  const [photos, setPhotos] = useState({}) // stopId -> [photo]
  const [uploadingStop, setUploadingStop] = useState(null)
  // Optimistic previews of offline-queued photos (so a tech sees their capture
  // instantly, before it has synced). Cleared as the outbox drains.
  const [pendingShots, setPendingShots] = useState({}) // stopId -> [{ id, url }]
  const outbox = usePhotoOutbox()

  async function refreshPhotos(rts = routes) {
    const ids = rts.flatMap((r) => r.stops.map((s) => s.id))
    try { setPhotos(await loadStopPhotos(ids)) } catch (e) {}
    // Drop optimistic previews for stops whose queue has now drained.
    setPendingShots((prev) => {
      const next = {}
      for (const [sid, arr] of Object.entries(prev)) {
        if ((outbox.byStop[sid] || 0) > 0) next[sid] = arr
      }
      return next
    })
  }

  async function addPhoto(stop, file) {
    if (!file) return
    setUploadingStop(stop.id)
    setErr(null)
    try {
      const gps = await getGps()
      // Queue, don't block on the upload — works offline, syncs to Supabase later.
      await queuePhoto({ stopId: stop.id, file, gps })
      // Instant local preview so the tech sees the capture before it's uploaded.
      const url = URL.createObjectURL(file)
      setPendingShots((prev) => ({ ...prev, [stop.id]: [...(prev[stop.id] || []), { id: url, url }] }))
      logActivity({ type: 'photo_added', summary: `Captured a photo at ${stop.name}`, entityType: 'route_stop', entityId: stop.id })
    } catch (e) { setErr(e.message || String(e)) }
    setUploadingStop(null)
  }
  async function removePhoto(photo) {
    setErr(null)
    try { await deleteStopPhoto(photo); await refreshPhotos() }
    catch (e) { setErr(e.message || String(e)) }
  }

  async function doCheckIn(stop) {
    setBusyStop(stop.id)
    setErr(null)
    try {
      const gps = await getGps()
      await checkInStop(stop.id, gps)
      logActivity({ type: 'check_in', summary: `Checked in at ${stop.name}`, entityType: 'route_stop', entityId: stop.id })
      // Always tell the property contact we've arrived — the SERVER decides
      // who actually gets it (multi-location managers auto-suppressed,
      // opt-outs honored, at-most-once per stop). Fire-and-forget.
      supabase.functions.invoke('notify-arrival', { body: { stopId: stop.id } }).catch(() => {})
      maybeNudge(stop) // fire-and-forget; never blocks the check-in
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }

  // Lawn pay is gated on check-in + photos. If a tech checks into the NEXT
  // stop while a previous one is missing photos or checkout, Randy texts them
  // right away (once per stop) so they can fix it before leaving the area.
  async function maybeNudge(stop) {
    try {
      const route = routes.find((r) => r.stops.some((x) => x.id === stop.id))
      if (!route || route.line !== 'lawn') return
      const prev = route.stops.find((x) =>
        x.id !== stop.id && x.checkIn && !x.nudgeSent && (!x.checkOut || (photos[x.id] || []).length === 0))
      if (!prev) return
      const drv = drivers.find((d) => d.id === route.driverId)
      if (!drv || !drv.phone) return
      const missing = !prev.checkOut ? 'checking out' : 'photos'
      await supabase.functions.invoke('sms', { body: {
        action: 'send',
        to: drv.phone,
        body: `Randy here — looks like you left ${prev.address || prev.name} without ${missing}. Add ${missing === 'photos' ? 'a photo' : 'a check-out'} when you can, or an admin will have to approve pay for that job.`,
        purpose: 'reminder',
        sentBy: 'Trashy Randy',
      } })
      await markStopNudged(prev.id)
      logActivity({ type: 'pay_nudge', summary: `Texted ${drv.full_name || 'tech'} about missing ${missing} at ${prev.address || prev.name}`, entityType: 'route_stop', entityId: prev.id })
    } catch (e) { /* nudges must never break dispatch */ }
  }
  async function doCheckOut(stop) {
    setBusyStop(stop.id)
    setErr(null)
    try {
      const gps = await getGps()
      await checkOutStop(stop.id, gps)
      logActivity({ type: 'check_out', summary: `Checked out of ${stop.name}`, entityType: 'route_stop', entityId: stop.id })
      // "Service complete" text — server-gated (only sends if completion texts are ON). Best-effort.
      supabase.functions.invoke('notify-complete', { body: { stopId: stop.id } }).catch(() => {})
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }
  async function doUndo(stop) {
    setBusyStop(stop.id)
    setErr(null)
    try { await resetStopStatus(stop.id); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }
  // Skip a stop (with a reason) instead of deleting it — it stays on the route
  // flagged SKIPPED so everyone can see it was intentionally passed over.
  async function doSkip(stop) {
    const reason = window.prompt(`Skip ${stop.name}?\n\nQuick reason (e.g. "gate locked", "client asked to skip this week"):`)
    if (reason === null) return
    setBusyStop(stop.id)
    setErr(null)
    try {
      const who = await currentActorName().catch(() => null)
      await skipStop(stop.id, reason, who)
      logActivity({ type: 'stop_skipped', summary: `Skipped ${stop.address || stop.name}${reason.trim() ? ` — ${reason.trim()}` : ''}`, entityType: 'property', entityId: stop.propertyId })
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }
  async function doUnskip(stop) {
    setBusyStop(stop.id)
    setErr(null)
    try {
      await unskipStop(stop.id)
      logActivity({ type: 'stop_unskipped', summary: `Un-skipped ${stop.address || stop.name}`, entityType: 'property', entityId: stop.propertyId })
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }

  async function doFlagExcess(stop) {
    if (stop.excessFlagged) {
      if (!window.confirm('Remove the excess flag from this stop?')) return
      setBusyStop(stop.id)
      try { await unflagStopExcess(stop.id); await refresh() } catch (e) { setErr(e.message || String(e)) }
      setBusyStop(null)
      return
    }
    const note = window.prompt('Flag this pickup as excessive.\nQuick note (e.g. "3 extra bags", "furniture left out"):')
    if (note === null) return
    setBusyStop(stop.id)
    try {
      await flagStopExcess(stop.id, note)
      logActivity({ type: 'excess_flagged', summary: `Flagged excessive pickup at ${stop.name}${note ? ` — ${note}` : ''}`, entityType: 'route_stop', entityId: stop.id })
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }

  async function refresh(d = date) {
    const [drv, rts, defs, cmb] = await Promise.all([
      loadDrivers(), loadDayDispatch(d, app.activeLine),
      loadRouteDefs(app.activeLine).catch(() => []), loadRouteCombos(d).catch(() => []),
    ])
    setDrivers(drv)
    setRoutes(rts)
    setRouteDefs(defs)
    setCombos(cmb)
    refreshPhotos(rts)
  }

  // Route B/C may not have a row for this date yet (only built routes exist per
  // day) — let the driver build it from schedules right here instead of
  // bouncing to Plan.
  async function buildMissing(code) {
    setBuilding(true)
    setErr(null)
    try {
      const r = await buildRouteFromSchedules(code, date)
      if (r && r.noSchedules) setErr(`Nothing is scheduled on Route ${code} for ${pretty(date)}.`)
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBuilding(false)
  }

  // ---- combine routes (this date only) ----
  function openCombo() {
    const first = routes.filter((r) => !combos.some((c) => c.codes.includes(r.code)))
    const pre = {}
    first.slice(0, 2).forEach((r) => { pre[r.code] = true })
    setComboCodes(pre)
    const drv = {}
    first.slice(0, 2).forEach((r) => { if (r.driverId) drv[r.driverId] = true })
    setComboDrivers(drv)
    setComboOpen(true)
  }
  // Keep the driver pre-selection in sync with the routes ticked (union of their drivers).
  function toggleComboCode(code) {
    setComboCodes((prev) => {
      const next = { ...prev, [code]: !prev[code] }
      const chosen = routes.filter((r) => next[r.code])
      setComboDrivers((d) => {
        const nd = { ...d }
        chosen.forEach((r) => { if (r.driverId && nd[r.driverId] === undefined) nd[r.driverId] = true })
        return nd
      })
      return next
    })
  }
  async function submitCombo() {
    const codes = Object.keys(comboCodes).filter((c) => comboCodes[c])
    if (codes.length < 2) { setErr('Pick at least two routes to combine.'); return }
    setComboBusy(true)
    setErr(null)
    try {
      const who = await currentActorName().catch(() => null)
      const driverIds = Object.keys(comboDrivers).filter((id) => comboDrivers[id])
      await createRouteCombo(date, codes, driverIds, who)
      const names = driverIds.map((id) => { const d = drivers.find((x) => x.id === id); return d ? driverName(d) : null }).filter(Boolean)
      logActivity({ type: 'routes_combined', summary: `Combined Route ${codes.join(' + ')} for ${pretty(date)}${names.length ? ` — ${names.join(' & ')}` : ''}`, entityType: 'route', entityId: null })
      setComboOpen(false)
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setComboBusy(false)
  }
  async function splitCombo(c) {
    if (!window.confirm(`Split Route ${c.codes.join(' + ')} back into separate routes for ${pretty(date)}?`)) return
    setComboBusy(true)
    try {
      await deleteRouteCombo(c.id)
      logActivity({ type: 'routes_split', summary: `Split Route ${c.codes.join(' + ')} back apart for ${pretty(date)}`, entityType: 'route', entityId: null })
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setComboBusy(false)
  }
  async function toggleComboDriver(c, driverId) {
    const has = (c.driverIds || []).includes(driverId)
    const next = has ? c.driverIds.filter((x) => x !== driverId) : [...(c.driverIds || []), driverId]
    try { await updateRouteComboDrivers(c.id, next); await refresh() }
    catch (e) { setErr(e.message || String(e)) }
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'route_combos' }, () => refresh(date).catch(() => {}))
      .subscribe()
    return () => { try { supabase.removeChannel(ch) } catch (e) {} }
  }, [date])

  // Route picker: 'all' shows the whole board; a code narrows it to that route
  // (or the combined run that route is part of today).
  const groups = useMemo(() => groupRoutesByCombo(routes, combos), [routes, combos])
  const visibleGroups = useMemo(() => (
    routeFilter === 'all' ? groups : groups.filter((g) => g.codes.includes(routeFilter))
  ), [groups, routeFilter])
  const comboGroups = visibleGroups.filter((g) => g.combo)
  const soloRoutes = visibleGroups.filter((g) => !g.combo).map((g) => g.routes[0])
  const filterMissing = routeFilter !== 'all' && !routes.some((r) => r.code === routeFilter)
  const comboCandidates = routes.filter((r) => !combos.some((c) => c.codes.includes(r.code)))

  // Group the (non-combined) routes by driver.
  const byDriver = useMemo(() => {
    const m = new Map()
    for (const r of soloRoutes) {
      const k = r.driverId || '__none__'
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return m
  }, [soloRoutes])

  const driverName = (d) => d.full_name || d.email
  const unassigned = byDriver.get('__none__') || []
  const activeDrivers = drivers.filter((d) => (byDriver.get(d.id) || []).length)
  const onCombo = new Set(comboGroups.flatMap((g) => g.driverIds))
  const idleDrivers = drivers.filter((d) => !(byDriver.get(d.id) || []).length && !onCombo.has(d.id))

  function routeStats(rts) {
    const stops = rts.reduce((n, r) => n + r.stops.length, 0)
    const done = rts.reduce((n, r) => n + r.stops.filter((s) => s.status === 'done').length, 0)
    return { stops, done }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* date nav (hidden when embedded — the Routes day picker drives the date) */}
      {!embedded && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '9px 12px' }}>
        <div onClick={() => setDate((d) => addDays(d, -1))} style={navBtn}>‹</div>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
          {pretty(date)}{date === TODAY && <span style={{ marginLeft: 8, fontSize: 11, color: '#1f7a4d', fontFamily: MONO }}>TODAY</span>}
        </div>
        <div onClick={() => setDate((d) => addDays(d, 1))} style={navBtn}>›</div>
        {date !== TODAY && <div onClick={() => setDate(TODAY)} style={{ fontSize: 12, fontWeight: 600, color: '#1f7a4d', border: '1px solid #cfe0d5', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>Today</div>}
      </div>
      )}

      {err && <div style={banner('#c0492f', '#fbeae6')}>{err}</div>}

      {/* route picker — every route on this line, not just the ones built today */}
      {routeDefs.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          {[{ code: 'all', name: 'All routes' }, ...routeDefs].map((rd) => {
            const sel = routeFilter === rd.code
            const built = rd.code === 'all' || routes.some((r) => r.code === rd.code)
            const inCombo = combos.find((c) => c.codes.includes(rd.code))
            return (
              <div key={rd.code} onClick={() => setRouteFilter(rd.code)} title={rd.code === 'all' ? 'Show every route' : built ? `Show Route ${rd.code}` : `Route ${rd.code} isn't built for this day yet`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${sel ? '#1f7a4d' : '#e6eae6'}`, background: sel ? '#e7f1eb' : '#fff', opacity: built ? 1 : 0.6 }}>
                {rd.code !== 'all' && <div style={{ width: 24, height: 24, borderRadius: 7, background: sel ? '#1f7a4d' : '#7c8a82', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontWeight: 600, fontSize: 11.5 }}>{rd.code}</div>}
                <div style={{ fontSize: 13, fontWeight: 600, color: sel ? '#15281d' : '#3a463f' }}>{rd.name}{inCombo ? <span style={{ marginLeft: 6, fontSize: 10, color: '#7a4ba0', fontFamily: MONO }}>⧉ {inCombo.codes.join('+')}</span> : null}</div>
              </div>
            )
          })}
          {comboCandidates.length >= 2 && !comboOpen && (
            <button onClick={openCombo} title="Run two routes as one today — e.g. one driver covering both. Routes themselves stay as planned." style={{ marginLeft: 'auto', background: '#fff', color: '#7a4ba0', border: '1px solid #d9c8ea', borderRadius: 10, padding: '8px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>⧉ Combine routes today</button>
          )}
        </div>
      )}

      {/* combine panel */}
      {comboOpen && (
        <div style={{ ...card, borderColor: '#d9c8ea', background: '#faf7fd' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Combine routes for {pretty(date)} only</div>
          <div style={{ fontSize: 12, color: '#7c8a82', marginBottom: 10 }}>The routes stay exactly as planned — the board just shows them as one run today. Split them again any time.</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#7c8a82', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Routes</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {comboCandidates.map((r) => (
              <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${comboCodes[r.code] ? '#7a4ba0' : '#e6eae6'}`, background: comboCodes[r.code] ? '#f1e9f8' : '#fff', borderRadius: 9, padding: '7px 11px', cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={!!comboCodes[r.code]} onChange={() => toggleComboCode(r.code)} />
                <span style={{ fontFamily: MONO, fontWeight: 700 }}>{r.code}</span> {r.name} <span style={{ color: '#9aa69e', fontSize: 11.5 }}>· {r.stops.length} stops{r.driverId ? ` · ${driverName(drivers.find((d) => d.id === r.driverId) || {}) || ''}` : ''}</span>
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#7c8a82', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Who's running it (one driver, or both riding together)</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {drivers.map((d) => (
              <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${comboDrivers[d.id] ? '#1f7a4d' : '#e6eae6'}`, background: comboDrivers[d.id] ? '#e7f1eb' : '#fff', borderRadius: 20, padding: '5px 11px 5px 8px', cursor: 'pointer', fontSize: 12.5 }}>
                <input type="checkbox" checked={!!comboDrivers[d.id]} onChange={() => setComboDrivers((p) => ({ ...p, [d.id]: !p[d.id] }))} />
                {driverName(d)}
              </label>
            ))}
            {drivers.length === 0 && <span style={{ fontSize: 12, color: '#9aa69e' }}>No drivers flagged yet (Team tab).</span>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={submitCombo} disabled={comboBusy} style={{ ...primaryBtn, background: '#7a4ba0' }}>{comboBusy ? 'Combining…' : `Combine for ${pretty(date)}`}</button>
            <button onClick={() => setComboOpen(false)} disabled={comboBusy} style={{ background: '#fff', color: '#5d6b63', border: '1px solid #e6eae6', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {outbox.pending > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: '#fbf3e2', border: '1px solid #ecd9ad', color: '#8a6d1e', borderRadius: 11, padding: '10px 14px', fontSize: 12.5, marginBottom: 14 }}>
          <span style={{ fontSize: 14 }}>📤</span>
          <span>{outbox.pending} photo{outbox.pending === 1 ? '' : 's'} queued — {typeof navigator !== 'undefined' && navigator.onLine ? 'uploading…' : 'will upload when back online.'}</span>
        </div>
      )}

      {loading ? (
        <div style={{ color: '#7c8a82', fontSize: 13, padding: 28, textAlign: 'center' }}>Loading dispatch…</div>
      ) : (
        <>
          {/* picked a route that hasn't been built for this day */}
          {filterMissing && (
            <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '30px 22px', textAlign: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Route {routeFilter} isn't built for {pretty(date)} yet</div>
              <div style={{ fontSize: 13, color: '#7c8a82', marginBottom: 14 }}>Build it from the schedules now, or set it up in route planning.</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={() => buildMissing(routeFilter)} disabled={building} style={primaryBtn}>{building ? 'Building…' : `⟳ Build Route ${routeFilter} from schedules`}</button>
                <button onClick={() => { app.setRoutesMode && app.setRoutesMode('plan'); go && go('routes') }} style={{ background: '#fff', color: '#1f7a4d', border: '1px solid #cfe0d5', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Open planning</button>
              </div>
            </div>
          )}

          {/* combined runs (this date only) */}
          {comboGroups.map((g) => {
            const { stops, done } = routeStats(g.routes)
            const open = expanded[g.key] !== false
            const ds = g.driverIds.map((id) => drivers.find((d) => d.id === id)).filter(Boolean)
            return (
              <div key={g.key} style={{ ...card, borderColor: '#d9c8ea', boxShadow: '0 0 0 3px #f1e9f8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                  <div onClick={() => setExpanded((e) => ({ ...e, [g.key]: !(e[g.key] !== false) }))} style={{ display: 'flex', alignItems: 'center', gap: 13, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', flex: 'none' }}>
                      {ds.length === 0 && <div style={{ ...avatar, background: '#c08a2e' }}>?</div>}
                      {ds.map((d, i) => <div key={d.id} style={{ ...avatar, marginLeft: i ? -12 : 0, border: '2px solid #fff', background: i ? '#5a3e78' : '#7a4ba0' }}>{initialsOf(driverName(d))}</div>)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{ds.length ? ds.map(driverName).join(' + ') : 'No driver picked'}</div>
                      <div style={{ fontSize: 12, color: '#7a4ba0', fontWeight: 600 }}>⧉ {g.routes.map((r) => `${r.code} · ${r.name}`).join('  +  ')} <span style={{ color: '#9aa69e', fontWeight: 500 }}>· combined for {date === TODAY ? 'today' : pretty(date)} only</span></div>
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700 }}>{done}/{stops}</div>
                      <div style={{ fontSize: 10.5, color: '#9aa69e' }}>stops done</div>
                    </div>
                    <div style={{ color: '#9aa69e', fontSize: 13, width: 16, textAlign: 'center' }}>{open ? '▾' : '▸'}</div>
                  </div>
                  <button onClick={() => splitCombo(g.combo)} disabled={comboBusy} title="Go back to separate routes for this day" style={{ flex: 'none', background: '#fff', color: '#7a4ba0', border: '1px solid #d9c8ea', borderRadius: 8, padding: '6px 11px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Split</button>
                </div>
                {open && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                    <span style={{ fontSize: 11, color: '#9aa69e' }}>Drivers:</span>
                    {drivers.map((d) => {
                      const on = g.driverIds.includes(d.id)
                      return <button key={d.id} onClick={() => toggleComboDriver(g.combo, d.id)} style={{ border: `1px solid ${on ? '#7a4ba0' : '#e6eae6'}`, background: on ? '#f1e9f8' : '#fff', color: on ? '#5a3e78' : '#7c8a82', borderRadius: 20, padding: '3px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>{on ? '✓ ' : ''}{driverName(d)}</button>
                    })}
                  </div>
                )}
                {open && g.routes.map((r) => (
                  <div key={r.id} style={{ marginTop: 12 }}>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: '#7c8a82', margin: '6px 2px' }}>{r.code} · {r.name}</div>
                    {r.stops.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#9aa69e', padding: '6px 2px' }}>No stops on this route.</div>
                    ) : r.stops.map((s) => <StopRow key={s.id} s={s} busy={busyStop === s.id} photos={photos[s.id] || []} pending={pendingShots[s.id] || []} syncing={outbox.byStop[s.id] || 0} uploading={uploadingStop === s.id} onCheckIn={() => doCheckIn(s)} onCheckOut={() => doCheckOut(s)} onUndo={() => doUndo(s)} onSkip={() => doSkip(s)} onUnskip={() => doUnskip(s)} onOpenClient={s.customerId && app.openClient ? () => app.openClient(s.customerId, s.propertyId) : null} onFlagExcess={() => doFlagExcess(s)} onAddPhoto={(f) => addPhoto(s, f)} onDeletePhoto={removePhoto} />)}
                  </div>
                ))}
              </div>
            )
          })}

          {/* on the road */}
          {!filterMissing && comboGroups.length === 0 && activeDrivers.length === 0 && unassigned.length === 0 && (
            <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '34px 22px', textAlign: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>No routes for {pretty(date)} yet</div>
              <div style={{ fontSize: 13, color: '#7c8a82', marginBottom: 14 }}>Build a route and assign a driver to see the day's dispatch here.</div>
              <button onClick={() => { app.setRoutesMode && app.setRoutesMode('plan'); go && go('routes') }} style={primaryBtn}>Go to route planning</button>
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
                    ) : r.stops.map((s) => <StopRow key={s.id} s={s} busy={busyStop === s.id} photos={photos[s.id] || []} pending={pendingShots[s.id] || []} syncing={outbox.byStop[s.id] || 0} uploading={uploadingStop === s.id} onCheckIn={() => doCheckIn(s)} onCheckOut={() => doCheckOut(s)} onUndo={() => doUndo(s)} onSkip={() => doSkip(s)} onUnskip={() => doUnskip(s)} onOpenClient={s.customerId && app.openClient ? () => app.openClient(s.customerId, s.propertyId) : null} onFlagExcess={() => doFlagExcess(s)} onAddPhoto={(f) => addPhoto(s, f)} onDeletePhoto={removePhoto} />)}
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
                <button onClick={() => { app.setRoutesMode && app.setRoutesMode('plan'); go && go('routes') }} style={{ ...primaryBtn, background: '#c08a2e' }}>Assign a driver</button>
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
            Expand a driver to check stops in/out, capture GPS, and attach photos.
          </div>
        </>
      )}
    </div>
  )
}

function StopRow({ s, busy, photos = [], pending = [], syncing = 0, uploading, onCheckIn, onCheckOut, onUndo, onSkip, onUnskip, onOpenClient, onFlagExcess, onAddPhoto, onDeletePhoto }) {
  const meta = STATUS_META[s.status] || STATUS_META.pending
  const fileRef = useRef(null)   // gallery / file picker
  const camRef = useRef(null)    // dedicated camera capture (opens rear cam on mobile)
  return (
    <div style={{ padding: '8px 4px', borderTop: '1px solid #f1f3f0', opacity: s.status === 'skipped' ? 0.75 : 1 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 22, height: 22, flex: 'none', borderRadius: '50%', background: meta.bg, color: meta.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 10.5, fontWeight: 600 }}>{s.seq}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div onClick={onOpenClient || undefined} title={onOpenClient ? `Open ${s.clientName || 'client'}'s record` : undefined} style={{ fontWeight: 600, fontSize: 13, cursor: onOpenClient ? 'pointer' : 'default', color: onOpenClient ? '#1f7a4d' : '#1a2420' }}>{s.name}</div>
          <div onClick={onOpenClient || undefined} style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: onOpenClient ? 'pointer' : 'default' }}>{s.address || s.service}</div>
          {(s.tags || []).length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
              {s.tags.map((t) => <span key={t.id} style={{ fontSize: 10, fontWeight: 700, color: t.color || '#1f7a4d', background: (t.color || '#1f7a4d') + '1a', border: `1px solid ${(t.color || '#1f7a4d')}55`, borderRadius: 5, padding: '1px 6px' }}>{t.name}</span>)}
            </div>
          )}
          {s.status === 'skipped' && (
            <div style={{ fontSize: 11, color: '#8a6d1e', marginTop: 2 }}>⤼ Skipped{s.skippedBy ? ` by ${s.skippedBy}` : ''}{s.skipReason ? ` — ${s.skipReason}` : ''}</div>
          )}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: meta.color, flex: 'none' }}>{meta.label}</div>
        {s.lat != null && s.lng != null && (
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600, color: '#fff', background: '#1f7a4d', borderRadius: 8, padding: '7px 12px', textDecoration: 'none', flex: 'none' }} title="Open turn-by-turn directions">➤ Navigate</a>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, marginLeft: 32, flexWrap: 'wrap' }}>
        {s.status === 'pending' && (
          <>
            <button onClick={onCheckIn} disabled={busy} style={fieldBtn('#1f7a4d')}>{busy ? '…' : 'Check in'}</button>
            <button onClick={onSkip} disabled={busy} title="Skip this stop with a reason — it stays on the route, flagged as skipped" style={{ background: '#fff', color: '#8a6d1e', border: '1px solid #e0cf9e', borderRadius: 8, padding: '6px 11px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>⤼ Skip</button>
          </>
        )}
        {s.status === 'skipped' && (
          <button onClick={onUnskip} disabled={busy} style={fieldBtnGhost} title="Put this stop back to pending">Un-skip</button>
        )}
        {s.status === 'enroute' && (
          <>
            <span style={{ fontSize: 11, color: '#7c8a82' }}>In {hhmm(s.checkIn)}</span>
            <button onClick={onCheckOut} disabled={busy} style={fieldBtn('#155e3a')}>{busy ? '…' : 'Check out'}</button>
            <button onClick={onUndo} disabled={busy} style={fieldBtnGhost} title="Undo check-in">undo</button>
          </>
        )}
        {s.status === 'done' && (
          <>
            <span style={{ fontSize: 11, color: '#1f7a4d', fontWeight: 600 }}>✓ {hhmm(s.checkIn)}–{hhmm(s.checkOut)}</span>
            <button onClick={onUndo} disabled={busy} style={fieldBtnGhost} title="Reopen stop">undo</button>
          </>
        )}
        {s.status !== 'pending' && s.status !== 'skipped' && (
          <button
            onClick={onFlagExcess}
            disabled={busy}
            title={s.excessFlagged ? `Flagged: ${s.excessNote || 'excessive'} — click to remove` : 'Flag this pickup as over the usual volume (extra charge review)'}
            style={{ background: s.excessFlagged ? '#faf3e2' : '#fff', border: `1px solid ${s.excessFlagged ? '#b07d18' : '#dde2dd'}`, color: '#8a6414', borderRadius: 8, padding: '6px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}
          >
            {s.excessFlagged ? '⚠ Excess flagged' : '⚠ Excess'}
          </button>
        )}
      </div>

      {/* photos */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, marginLeft: 32, flexWrap: 'wrap' }}>
        {photos.map((p) => (
          <div key={p.id} style={{ position: 'relative', width: 46, height: 46 }}>
            <a href={p.url} target="_blank" rel="noreferrer">
              <img src={p.url} alt="stop" style={{ width: 46, height: 46, objectFit: 'cover', borderRadius: 8, border: '1px solid #e6eae6', display: 'block' }} />
            </a>
            <button onClick={() => onDeletePhoto(p)} title="Delete photo" style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#c0492f', color: '#fff', border: '2px solid #fff', fontSize: 10, lineHeight: 1, cursor: 'pointer', padding: 0 }}>×</button>
          </div>
        ))}
        {/* Optimistic previews of offline-queued captures (sync pending). */}
        {pending.map((p) => (
          <div key={p.id} title="Captured — uploading when online" style={{ position: 'relative', width: 46, height: 46, borderRadius: 8, overflow: 'hidden', border: '1.5px dashed #c08a2e' }}>
            <img src={p.url} alt="syncing" style={{ width: 46, height: 46, objectFit: 'cover', display: 'block', opacity: 0.85 }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,30,20,.32)', color: '#fff', fontSize: 13 }}>⟳</div>
          </div>
        ))}
        {/* Camera capture — opens the device rear camera on mobile. */}
        <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onAddPhoto(f) }} />
        <button onClick={() => camRef.current && camRef.current.click()} disabled={uploading} style={{ width: 46, height: 46, borderRadius: 8, border: 'none', background: '#1f7a4d', color: '#fff', fontSize: 17, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Take a photo">
          {uploading ? '…' : '📷'}
        </button>
        {/* Attach from gallery / files. */}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onAddPhoto(f) }} />
        <button onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} style={{ width: 46, height: 46, borderRadius: 8, border: '1.5px dashed #c2ccc3', background: '#fff', color: '#9aa69e', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Attach from gallery / files">
          +
        </button>
        {photos.length > 0 && <span style={{ fontSize: 10.5, color: '#9aa69e', fontFamily: MONO }}>{photos.length} photo{photos.length === 1 ? '' : 's'}</span>}
        {syncing > 0 && <span style={{ fontSize: 10.5, color: '#c08a2e', fontFamily: MONO, display: 'inline-flex', alignItems: 'center', gap: 4 }}>⟳ {syncing} syncing</span>}
      </div>
    </div>
  )
}

const fieldBtn = (bg) => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer' })
const fieldBtnGhost = { background: '#fff', color: '#9aa69e', border: '1px solid #e6eae6', borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }

const navBtn = { width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid #e6eae6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 15 }
const card = { background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '14px 16px', marginBottom: 12 }
const avatar = { width: 42, height: 42, flex: 'none', borderRadius: '50%', background: '#3a5246', color: '#dff0e6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 14 }
const primaryBtn = { background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const banner = (color, bg) => ({ background: bg, color, border: `1px solid ${color}33`, borderRadius: 10, padding: '12px 14px', fontSize: 13, marginBottom: 14 })
