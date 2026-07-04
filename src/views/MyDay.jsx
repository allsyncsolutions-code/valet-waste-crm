// Lawn tech "My Day" — replaces Drivers & Field on the Lawn line. One card per
// job with map, On My Way (texts the client), Clock In (check-in), Mark
// Complete (check-out), Directions, photos, notes, client + team info.
// Techs see only their own route; admins can view any tech's day.
import { useEffect, useMemo, useRef, useState } from 'react'
import { MONO } from '../data.js'
import { loadDayDispatch, checkInStop, checkOutStop, resetStopStatus, markStopOnMyWay, markStopNudged } from '../lib/routesData.js'
import { loadStopPhotos, uploadStopPhoto, deleteStopPhoto } from '../lib/photosData.js'
import { loadDrivers } from '../lib/teamData.js'
import { logActivity } from '../lib/activityData.js'
import { supabase } from '../lib/supabaseClient.js'

const LAWN = '#7a9e2e'
const GREEN = '#1f7a4d'
const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY = iso(new Date())
const pretty = (key) => new Date(key + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d) }
const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')

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

const STATUS = {
  pending: { label: 'SCHEDULED', color: '#2f6db0', bg: '#e8f0fa' },
  onmyway: { label: 'ON MY WAY', color: '#8a6414', bg: '#faf3e2' },
  enroute: { label: 'IN PROGRESS', color: LAWN, bg: '#f1f6e4' },
  done: { label: 'COMPLETE', color: GREEN, bg: '#e6f3ec' },
}
const stopPhase = (s) => (s.checkOut ? 'done' : s.checkIn ? 'enroute' : s.onMyWayAt ? 'onmyway' : 'pending')

export default function MyDay({ app }) {
  const me = app.user || {}
  const isAdmin = me.role === 'admin'

  const [date, setDate] = useState(TODAY)
  const [routes, setRoutes] = useState([])
  const [drivers, setDrivers] = useState([])
  const [photos, setPhotos] = useState({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busyStop, setBusyStop] = useState(null)
  const [uploadingStop, setUploadingStop] = useState(null)
  const [openStop, setOpenStop] = useState(null) // expanded job card
  const [viewTech, setViewTech] = useState('me') // admin: 'me' | profile id | 'all'

  async function refresh(d = date) {
    const [drv, rts] = await Promise.all([loadDrivers(), loadDayDispatch(d, 'lawn')])
    setDrivers(drv)
    setRoutes(rts)
    try { setPhotos(await loadStopPhotos(rts.flatMap((r) => r.stops.map((s) => s.id)))) } catch (e) {}
  }
  useEffect(() => {
    setLoading(true)
    setErr('')
    refresh(date).catch((e) => setErr(e.message || String(e))).finally(() => setLoading(false))
  }, [date])

  useEffect(() => {
    const ch = supabase
      .channel('myday-' + date)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'route_stops' }, () => refresh(date).catch(() => {}))
      .subscribe()
    return () => { try { supabase.removeChannel(ch) } catch (e) {} }
  }, [date])

  const driverName = (id) => { const d = drivers.find((x) => x.id === id); return d ? (d.full_name || d.email) : 'Unassigned' }

  // My jobs (techs) or the picked tech's jobs (admins), flattened across routes.
  const jobs = useMemo(() => {
    const want = isAdmin ? viewTech : 'me'
    const mine = (r) => (want === 'all' ? true : want === 'me' ? r.driverId === me.id : r.driverId === want)
    return routes.filter(mine).flatMap((r) => r.stops.map((s) => ({ ...s, route: r.code, routeName: r.name, driverId: r.driverId })))
  }, [routes, isAdmin, viewTech, me.id])
  const doneCount = jobs.filter((s) => s.checkOut).length

  // Techs with routes today (admin picker).
  const techsToday = useMemo(() => [...new Set(routes.map((r) => r.driverId).filter(Boolean))], [routes])

  async function onMyWay(s) {
    setBusyStop(s.id)
    setErr('')
    try {
      await markStopOnMyWay(s.id)
      if (s.clientPhone) {
        // Fire the client text; a failure never blocks the status.
        supabase.functions.invoke('sms', { body: {
          action: 'send',
          to: s.clientPhone,
          body: `Hi ${s.clientName || 'there'}, your Valet Waste lawn tech is on the way to ${s.address || 'your property'}. — Valet Waste FL`,
          purpose: 'on_my_way',
          sentBy: driverName(s.driverId),
        } }).catch(() => {})
      }
      logActivity({ type: 'on_my_way', summary: `${driverName(s.driverId)} en route to ${s.address || s.name}${s.clientPhone ? ' (client texted)' : ''}`, entityType: 'route_stop', entityId: s.id })
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }

  async function clockIn(s) {
    setBusyStop(s.id)
    setErr('')
    try {
      const gps = await getGps()
      await checkInStop(s.id, gps)
      logActivity({ type: 'check_in', summary: `Clocked in at ${s.address || s.name}`, entityType: 'route_stop', entityId: s.id })
      maybeNudge(s)
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }

  async function markComplete(s) {
    if ((photos[s.id] || []).length === 0 && !window.confirm('No photos on this job yet — pay needs at least one. Mark complete anyway?')) return
    setBusyStop(s.id)
    setErr('')
    try {
      const gps = await getGps()
      await checkOutStop(s.id, gps)
      logActivity({ type: 'check_out', summary: `Completed ${s.address || s.name}`, entityType: 'route_stop', entityId: s.id })
      await refresh()
    } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }

  async function undo(s) {
    setBusyStop(s.id)
    try { await resetStopStatus(s.id); await refresh() } catch (e) { setErr(e.message || String(e)) }
    setBusyStop(null)
  }

  // Same guard-rail as dispatch: clocking into the next job nudges about an
  // earlier one that's missing checkout/photos.
  async function maybeNudge(stop) {
    try {
      const prev = jobs.find((x) => x.id !== stop.id && x.checkIn && !x.nudgeSent && (!x.checkOut || (photos[x.id] || []).length === 0))
      if (!prev) return
      const drv = drivers.find((d) => d.id === stop.driverId)
      if (!drv || !drv.phone) return
      const missing = !prev.checkOut ? 'marking complete' : 'photos'
      await supabase.functions.invoke('sms', { body: {
        action: 'send',
        to: drv.phone,
        body: `Randy here — looks like you left ${prev.address || prev.name} without ${missing}. Add ${missing === 'photos' ? 'a photo' : 'a completion'} when you can, or an admin will have to approve pay for that job.`,
        purpose: 'reminder',
        sentBy: 'Trashy Randy',
      } })
      await markStopNudged(prev.id)
    } catch (e) { /* nudges never break the flow */ }
  }

  async function addPhoto(s, file) {
    if (!file) return
    setUploadingStop(s.id)
    setErr('')
    try {
      const gps = await getGps()
      await uploadStopPhoto(s.id, file, gps)
      logActivity({ type: 'photo_added', summary: `Added a photo at ${s.address || s.name}`, entityType: 'route_stop', entityId: s.id })
      setPhotos(await loadStopPhotos(jobs.map((x) => x.id)))
    } catch (e) { setErr(e.message || String(e)) }
    setUploadingStop(null)
  }
  async function removePhoto(p) {
    try { await deleteStopPhoto(p); setPhotos(await loadStopPhotos(jobs.map((x) => x.id))) } catch (e) { setErr(e.message || String(e)) }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      {/* date nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, padding: '9px 12px' }}>
        <div onClick={() => setDate((d) => addDays(d, -1))} style={navBtn}>‹</div>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
          {pretty(date)}{date === TODAY && <span style={{ marginLeft: 8, fontSize: 11, color: LAWN, fontFamily: MONO }}>TODAY</span>}
        </div>
        <div onClick={() => setDate((d) => addDays(d, 1))} style={navBtn}>›</div>
        {date !== TODAY && <div onClick={() => setDate(TODAY)} style={{ fontSize: 12, fontWeight: 600, color: LAWN, border: '1px solid #dde5c9', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>Today</div>}
      </div>

      {/* admin tech picker */}
      {isAdmin && techsToday.length > 0 && (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>
          <Chip on={viewTech === 'me'} onClick={() => setViewTech('me')}>My jobs</Chip>
          {techsToday.map((id) => <Chip key={id} on={viewTech === id} onClick={() => setViewTech(id)}>{driverName(id)}</Chip>)}
          <Chip on={viewTech === 'all'} onClick={() => setViewTech('all')}>Everyone</Chip>
        </div>
      )}

      {err && <div style={{ background: '#fbeae6', color: '#c0492f', borderRadius: 10, padding: '10px 13px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {loading ? (
        <div style={{ color: '#7c8a82', fontSize: 13, padding: 28, textAlign: 'center' }}>Loading your day…</div>
      ) : jobs.length === 0 ? (
        <div style={{ background: '#fff', border: '1px dashed #d8ddd6', borderRadius: 14, padding: '34px 22px', textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>No jobs {date === TODAY ? 'today' : 'this day'}</div>
          <div style={{ fontSize: 13, color: '#7c8a82' }}>{isAdmin ? 'Assign lawn routes in Routes & Dispatch.' : 'Nothing assigned to you — check with your admin.'}</div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: '#7c8a82', marginBottom: 10 }}>{doneCount}/{jobs.length} complete</div>
          {jobs.map((s) => (
            <JobCard
              key={s.id}
              s={s}
              open={openStop === s.id}
              onToggle={() => setOpenStop(openStop === s.id ? null : s.id)}
              busy={busyStop === s.id}
              photos={photos[s.id] || []}
              uploading={uploadingStop === s.id}
              team={driverName(s.driverId)}
              onOnMyWay={() => onMyWay(s)}
              onClockIn={() => clockIn(s)}
              onComplete={() => markComplete(s)}
              onUndo={() => undo(s)}
              onAddPhoto={(f) => addPhoto(s, f)}
              onDeletePhoto={removePhoto}
            />
          ))}
        </>
      )}
    </div>
  )
}

function JobCard({ s, open, onToggle, busy, photos, uploading, team, onOnMyWay, onClockIn, onComplete, onUndo, onAddPhoto, onDeletePhoto }) {
  const phase = stopPhase(s)
  const meta = STATUS[phase]
  const fileRef = useRef(null)
  const hasCoords = s.lat != null && s.lng != null && !(Number(s.lat) === 0 && Number(s.lng) === 0)
  const dest = hasCoords ? `${s.lat},${s.lng}` : encodeURIComponent(s.address || '')

  return (
    <div style={{ background: '#fff', border: '1px solid #e6eae6', borderRadius: 13, marginBottom: 10, overflow: 'hidden' }}>
      {/* header row */}
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 15px', cursor: 'pointer' }}>
        <div style={{ width: 24, height: 24, flex: 'none', borderRadius: '50%', background: meta.bg, color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 11, fontWeight: 700 }}>{s.seq}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.clientName || s.name}</div>
          <div style={{ fontSize: 12, color: '#7c8a82', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.address}{s.window ? ` · ${s.window}` : ''}</div>
        </div>
        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: meta.color, background: meta.bg, borderRadius: 6, padding: '4px 8px', flex: 'none' }}>{meta.label}</span>
        <span style={{ color: '#9aa69e', fontSize: 13 }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid #f1f3f0' }}>
          {/* map */}
          {(hasCoords || s.address) && (
            <iframe
              title={`map-${s.id}`}
              src={`https://maps.google.com/maps?q=${dest}&z=15&output=embed`}
              style={{ width: '100%', height: 180, border: 'none', display: 'block' }}
              loading="lazy"
            />
          )}

          {/* action buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, padding: '12px 15px' }}>
            {phase === 'pending' && (
              <button onClick={onOnMyWay} disabled={busy} style={bigBtn('#2f6db0')}>{busy ? '…' : '🚐 On My Way'}</button>
            )}
            {(phase === 'pending' || phase === 'onmyway') && (
              <button onClick={onClockIn} disabled={busy} style={bigBtn(LAWN)}>{busy ? '…' : '⏱ Clock In'}</button>
            )}
            {phase === 'enroute' && (
              <button onClick={onComplete} disabled={busy} style={bigBtn(GREEN)}>{busy ? '…' : '✓ Mark Complete'}</button>
            )}
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${dest}`} target="_blank" rel="noreferrer" style={{ ...bigBtn('#fff'), color: '#3a4a41', border: '1px solid #dde2dd', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>➤ Directions</a>
            {phase === 'onmyway' && <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: '#8a6414' }}>On my way sent {hhmm(s.onMyWayAt)}{s.clientPhone ? ' — client texted' : ' — client has no phone on file'}</div>}
            {phase === 'enroute' && <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: '#7c8a82' }}>Clocked in {hhmm(s.checkIn)} · <span onClick={onUndo} style={{ color: '#9aa69e', cursor: 'pointer', textDecoration: 'underline' }}>undo</span></div>}
            {phase === 'done' && <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: GREEN, fontWeight: 600 }}>✓ {hhmm(s.checkIn)}–{hhmm(s.checkOut)} · <span onClick={onUndo} style={{ color: '#9aa69e', cursor: 'pointer', textDecoration: 'underline', fontWeight: 400 }}>reopen</span></div>}
          </div>

          {/* details */}
          <div style={{ padding: '2px 15px 13px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <Row label="Notes">{s.notes || <i style={{ color: '#9aa69e' }}>No notes for this job.</i>}</Row>
            <Row label="Client">{s.clientName || '—'}</Row>
            <Row label="Team">{team}</Row>
            <Row label="Address">
              <a href={`https://www.google.com/maps/search/?api=1&query=${dest}`} target="_blank" rel="noreferrer" style={{ color: '#2f6db0' }}>{s.address || '—'}</a>
            </Row>
            <Row label="Service">{s.service || 'Lawn care'}</Row>
            {s.techPay != null && <Row label="Job pay">{`$${Number(s.techPay).toFixed(2)}`}<span style={{ color: '#9aa69e', fontSize: 11 }}> — pays with clock-in + complete + photo</span></Row>}

            {/* photos */}
            <div>
              <div style={rowLabel}>Job photos {photos.length === 0 && <span style={{ color: '#c0492f', fontWeight: 400 }}>(required for pay)</span>}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 5 }}>
                {photos.map((p) => (
                  <div key={p.id} style={{ position: 'relative', width: 56, height: 56 }}>
                    <a href={p.url} target="_blank" rel="noreferrer">
                      <img src={p.url} alt="job" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 9, border: '1px solid #e6eae6', display: 'block' }} />
                    </a>
                    <button onClick={() => onDeletePhoto(p)} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#c0492f', color: '#fff', border: '2px solid #fff', fontSize: 10, lineHeight: 1, cursor: 'pointer', padding: 0 }}>×</button>
                  </div>
                ))}
                <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onAddPhoto(f) }} />
                <button onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading} style={{ width: 56, height: 56, borderRadius: 9, border: '1.5px dashed #c2ccc3', background: '#fff', color: '#9aa69e', fontSize: 20, cursor: 'pointer' }}>{uploading ? '…' : '📷'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div>
      <div style={rowLabel}>{label}</div>
      <div style={{ fontSize: 13.5, marginTop: 2 }}>{children}</div>
    </div>
  )
}
function Chip({ on, onClick, children }) {
  return (
    <div onClick={onClick} style={{ fontSize: 12, fontWeight: 600, borderRadius: 16, padding: '6px 13px', cursor: 'pointer', background: on ? '#3a5246' : '#fff', color: on ? '#dff0e6' : '#5d6b63', border: `1px solid ${on ? '#3a5246' : '#dde2dd'}` }}>{children}</div>
  )
}

const rowLabel = { fontSize: 11.5, fontWeight: 700, color: '#5d6b63' }
const navBtn = { width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid #e6eae6', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#5d6b63', fontSize: 15 }
const bigBtn = (bg) => ({ background: bg, color: '#fff', border: 'none', borderRadius: 10, padding: '12px 0', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', textAlign: 'center' })
