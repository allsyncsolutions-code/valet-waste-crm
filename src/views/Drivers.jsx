import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { STATUS_META } from '../lib/routeModel.js'
import { loadDayDispatch, checkInStop, checkOutStop, resetStopStatus, flagStopExcess, unflagStopExcess, markStopNudged } from '../lib/routesData.js'
import { loadStopPhotos, uploadStopPhoto, deleteStopPhoto } from '../lib/photosData.js'
import { loadDrivers } from '../lib/teamData.js'
import { logActivity } from '../lib/activityData.js'
import { supabase } from '../lib/supabaseClient.js'

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

export default function Drivers({ app }) {
  const isMobile = app.isMobile
  const go = app.go

  const [date, setDate] = useState(TODAY)
  const [drivers, setDrivers] = useState([])
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [expanded, setExpanded] = useState({}) // driverId/route key -> bool
  const [busyStop, setBusyStop] = useState(null)
  const [photos, setPhotos] = useState({}) // stopId -> [photo]
  const [uploadingStop, setUploadingStop] = useState(null)

  async function refreshPhotos(rts = routes) {
    const ids = rts.flatMap((r) => r.stops.map((s) => s.id))
    try { setPhotos(await loadStopPhotos(ids)) } catch (e) {}
  }

  async function addPhoto(stop, file) {
    if (!file) return
    setUploadingStop(stop.id)
    setErr(null)
    try {
      const gps = await getGps()
      await uploadStopPhoto(stop.id, file, gps)
      logActivity({ type: 'photo_added', summary: `Added a photo at ${stop.name}`, entityType: 'route_stop', entityId: stop.id })
      await refreshPhotos()
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
    const [drv, rts] = await Promise.all([loadDrivers(), loadDayDispatch(d, app.activeLine)])
    setDrivers(drv)
    setRoutes(rts)
    refreshPhotos(rts)
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
                    ) : r.stops.map((s) => <StopRow key={s.id} s={s} busy={busyStop === s.id} photos={photos[s.id] || []} uploading={uploadingStop === s.id} onCheckIn={() => doCheckIn(s)} onCheckOut={() => doCheckOut(s)} onUndo={() => doUndo(s)} onFlagExcess={() => doFlagExcess(s)} onAddPhoto={(f) => addPhoto(s, f)} onDeletePhoto={removePhoto} />)}
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
            Expand a driver to check stops in/out, capture GPS, and attach photos.
          </div>
        </>
      )}
    </div>
  )
}

function StopRow({ s, busy, photos = [], uploading, onCheckIn, onCheckOut, onUndo, onFlagExcess, onAddPhoto, onDeletePhoto }) {
  const meta = STATUS_META[s.status] || STATUS_META.pending
  const fileRef = useRef(null)
  return (
    <div style={{ padding: '8px 4px', borderTop: '1px solid #f1f3f0' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 22, height: 22, flex: 'none', borderRadius: '50%', background: meta.bg, color: meta.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 10.5, fontWeight: 600 }}>{s.seq}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
          <div style={{ fontSize: 11.5, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address || s.service}</div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: meta.color, flex: 'none' }}>{meta.label}</div>
        {s.lat != null && s.lng != null && (
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600, color: '#fff', background: '#1f7a4d', borderRadius: 8, padding: '7px 12px', textDecoration: 'none', flex: 'none' }} title="Open turn-by-turn directions">➤ Navigate</a>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, marginLeft: 32, flexWrap: 'wrap' }}>
        {s.status === 'pending' && (
          <button onClick={onCheckIn} disabled={busy} style={fieldBtn('#1f7a4d')}>{busy ? '…' : 'Check in'}</button>
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
        {s.status !== 'pending' && (
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
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onAddPhoto(f) }} />
        <button onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} style={{ width: 46, height: 46, borderRadius: 8, border: '1.5px dashed #c2ccc3', background: '#fff', color: '#9aa69e', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Add photo">
          {uploading ? '…' : '+'}
        </button>
        {photos.length > 0 && <span style={{ fontSize: 10.5, color: '#9aa69e', fontFamily: MONO }}>{photos.length} photo{photos.length === 1 ? '' : 's'}</span>}
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
