// Data layer for the routes slice — all Supabase reads/writes live here so the
// views stay declarative. route_stops is the single source of truth shared by
// dispatch and the driver view.
import { supabase } from './supabaseClient.js'
import { loadSettings, settingsDepot, geocodeAddress } from './settingsData.js'
import { createClient } from './customersData.js'

const DEFAULT_DEPOT = { name: 'AllSync Yard', lat: 44.804, lng: -93.278 }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// Parse 'YYYY-MM-DD' at local noon (avoids timezone-rollover surprises).
function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0)
}
export function weekdayName(dateStr) {
  return WEEKDAYS[parseDate(dateStr).getDay()]
}
// Which occurrence of this weekday within its month (1st, 2nd, ...).
function nthWeekdayOfMonth(date) {
  return Math.floor((date.getDate() - 1) / 7) + 1
}

// Does a recurring schedule fall on a specific calendar date?
export function scheduleHitsDate(sched, dateStr) {
  if (!sched || sched.active === false) return false
  const date = parseDate(dateStr)
  if (WEEKDAYS[date.getDay()] !== sched.day_of_week) return false
  if (sched.start_date && parseDate(sched.start_date) > date) return false
  const nth = nthWeekdayOfMonth(date)
  switch (sched.frequency) {
    case 'weekly': return true
    case 'biweekly': {
      if (!sched.start_date) return true
      const weeks = Math.round((date - parseDate(sched.start_date)) / (7 * 864e5))
      return weeks % 2 === 0
    }
    case 'monthly': return nth === 1
    case '1st_3rd': return nth === 1 || nth === 3
    case '2nd_4th': return nth === 2 || nth === 4
    default: return false // on_call etc. never auto-populate
  }
}

// The pickup day(s) now live on each property (properties.pickup_days), so a
// property can be serviced on more than one weekday. This returns one synthetic
// schedule row per (property, day) — the shape scheduleHitsDate expects — so the
// day dots, "build from schedules", and dashboard counts all stay property-aware.
export async function loadActiveSchedules(line) {
  let q = supabase
    .from('properties')
    .select('id, customer_id, service, pickup_days, pickup_frequency, pickup_start_date, business_line')
    .eq('paused', false) // paused addresses are off all routes
  if (line) q = q.eq('business_line', line)
  const { data, error } = await q
  if (error) throw error
  const rows = []
  for (const p of data || []) {
    for (const day of p.pickup_days || []) {
      rows.push({
        property_id: p.id,
        customer_id: p.customer_id,
        service: p.service || '',
        day_of_week: day,
        frequency: p.pickup_frequency || 'weekly',
        start_date: p.pickup_start_date || null,
        active: true,
      })
    }
  }
  return rows
}

// DB row (with joined property) -> the shape the UI uses.
// Client tags (customer_tags → tags) flattened to [{id,name,color}] — shown on
// stop cards in both Plan and Field so drivers see e.g. "gate code" / "VIP".
export function tagsOf(customer) {
  return ((customer && customer.customer_tags) || []).map((ct) => ct.tag).filter(Boolean)
}

function mapStop(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    seq: row.seq,
    status: row.status,
    service: row.service || row.properties?.service || '',
    window: row.time_window || '',
    // Prefer the PROPERTY's current coordinates over the stop's cached copy, so
    // re-geocoding a fixed address moves the pin immediately (the stop's lat/lng
    // is only a fallback for when the property join is missing).
    lat: row.properties?.lat ?? row.lat,
    lng: row.properties?.lng ?? row.lng,
    name: row.properties?.name || 'Unknown',
    address: row.properties?.address || '',
    needsReview: !!row.properties?.needs_review,
    customerId: row.properties?.customer_id || null,
    clientName: row.properties?.customers?.name || null,
    tags: tagsOf(row.properties?.customers),
    pickupDays: row.properties?.pickup_days || [],
    pickupFrequency: row.properties?.pickup_frequency || null,
    skipReason: row.skip_reason || '',
    skippedBy: row.skipped_by || null,
  }
}

// Load one route's depot, ordered stops, and the unrouted properties.
// A route is identified by code + service_date, so each day has its own route.
export async function loadRouteSlice(code = 'B', date = null, line = null) {
  // The configured starting location (Settings) is the map home + optimizer
  // start, unless a specific route overrides it with its own depot.
  const settings = await loadSettings().catch(() => null)
  const homeDepot = settingsDepot(settings) || DEFAULT_DEPOT

  let rq = supabase.from('routes').select('*').eq('code', code)
  rq = date ? rq.eq('service_date', date) : rq.is('service_date', null)
  const { data: route, error: rErr } = await rq.maybeSingle()
  if (rErr) throw rErr

  // No route yet (e.g. fresh/empty database) — return an empty slice so the
  // view shows an empty state instead of erroring.
  if (!route) {
    return { route: null, depot: homeDepot, stops: [], unrouted: [] }
  }

  const { data: stopRows, error: sErr } = await supabase
    .from('route_stops')
    .select('id, property_id, seq, status, service, time_window, lat, lng, skip_reason, skipped_by, properties(name, address, service, lat, lng, needs_review, customer_id, pickup_days, pickup_frequency, customers(name, customer_tags(tag:tags(id,name,color))))')
    .eq('route_id', route.id)
    .order('seq', { ascending: true })
  if (sErr) throw sErr
  const stops = stopRows.map(mapStop)

  let pq = supabase
    .from('properties')
    .select('id, name, address, service, lat, lng, pickup_days, pickup_frequency, pickup_start_date, needs_review')
    .eq('paused', false) // paused addresses never show up as unrouted/due
  if (line) pq = pq.eq('business_line', line) // only this line's properties can be "unrouted" here
  const { data: props, error: pErr } = await pq
  if (pErr) throw pErr

  const onRoute = new Set(stops.map((s) => s.propertyId))
  // Properties already placed on ANOTHER route this date are not "unrouted" —
  // a stop only needs to be on one route for the day, so don't flag it while
  // planning a different route. The propertyId → code map also labels those
  // stops in the "+ Add stops" picker, where they stay selectable: putting the
  // same address on a second (alternate/backup) route for the day is allowed.
  let placedElsewhere = new Set()
  let elsewhereCodes = {}
  if (date) {
    const { data: dayRoutes } = await supabase.from('routes').select('id, code').eq('service_date', date).neq('id', route.id)
    if (dayRoutes && dayRoutes.length) {
      const { data: dayStops } = await supabase.from('route_stops').select('property_id, route_id').in('route_id', dayRoutes.map((r) => r.id))
      for (const s of dayStops || []) {
        placedElsewhere.add(s.property_id)
        const code = (dayRoutes.find((r) => r.id === s.route_id) || {}).code
        if (code) elsewhereCodes[s.property_id] = code
      }
    }
  }
  // "Unrouted" means due on THIS date but not yet placed on the route — not the
  // whole customer base. Properties scheduled for other days are added on demand
  // via "+ Add stops". After a clean build this list is empty.
  // One-time day changes (property_day_overrides) adjust what's due: a skip
  // override removes the property from this date, a service override adds it.
  const ov = date ? await loadDayOverrides(date).catch(() => null) : null
  const isDue = (p) => {
    if (ov?.skips?.has(p.id)) return false
    if (ov?.extras?.has(p.id)) return true
    return (p.pickup_days || []).some((d) =>
      scheduleHitsDate({ day_of_week: d, frequency: p.pickup_frequency || 'weekly', start_date: p.pickup_start_date || null, active: true }, date))
  }
  const unrouted = props
    .filter((p) => date && !onRoute.has(p.id) && !placedElsewhere.has(p.id) && isDue(p))
    .map((p) => ({
      id: `prop:${p.id}`,
      propertyId: p.id,
      name: p.name,
      address: p.address || '',
      service: p.service || '',
      window: '',
      lat: p.lat,
      lng: p.lng,
      status: 'pending',
      needsReview: !!p.needs_review,
      pickupDays: p.pickup_days || [],
      pickupFrequency: p.pickup_frequency || null,
    }))

  const depot = route.depot_lat != null
    ? { name: route.depot_name || homeDepot.name, lat: route.depot_lat, lng: route.depot_lng }
    : homeDepot
  return { route, depot, stops, unrouted, placedElsewhereIds: [...placedElsewhere], elsewhereCodes }
}

// Persist a new visit order (writes seq for every stop).
export async function persistOrder(stops) {
  await Promise.all(
    stops.map((s) =>
      supabase.from('route_stops').update({ seq: s.seq }).eq('id', s.id)
    )
  )
}

// Add an unrouted property to the route at the end; returns the new stop id.
export async function addStopToRoute(routeId, property, seq) {
  const { data, error } = await supabase
    .from('route_stops')
    .insert({
      route_id: routeId,
      property_id: property.propertyId,
      seq,
      status: 'pending',
      service: property.service,
      lat: property.lat,
      lng: property.lng,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// Sync the route FOR A SPECIFIC DATE to its recurring schedules. This is
// self-correcting: every property whose own pickup day(s) land on `date`
// (weekday + start date + frequency) is added, and any recurring stop that is
// NOT due that day is removed — so a client's Tuesday and Friday addresses stay
// on the right routes and stale stops can't pile up. Preserved on removal:
//   - one-off / unscheduled stops (property has no pickup_days) — manual adds
//   - stops already checked in or completed (status 'enroute' / 'done')
export async function buildRouteFromSchedules(code = 'B', date = null) {
  if (!date) throw new Error('A date is required.')

  // Which properties are due on this date? Only the ROUTE's business line —
  // route codes are line-unique in the catalog, so derive it from there (keeps
  // trash properties off lawn routes and vice versa).
  const { data: def } = await supabase
    .from('route_defaults').select('business_line').eq('code', code).maybeSingle()
  const scheds = await loadActiveSchedules(def?.business_line || null)
  const due = scheds.filter((s) => scheduleHitsDate(s, date))
  const dueIds = new Set(due.map((s) => s.property_id).filter(Boolean))

  // Apply one-time day changes: skip overrides pull a property off this date,
  // service overrides add it (same business line only).
  const ov = await loadDayOverrides(date).catch(() => null)
  if (ov) {
    for (const id of ov.skips) dueIds.delete(id)
    const extraIds = [...ov.extras].filter((id) => !dueIds.has(id))
    if (extraIds.length) {
      const { data: extraProps } = await supabase
        .from('properties').select('id, business_line, paused').in('id', extraIds)
      for (const p of extraProps || []) {
        if (p.paused) continue
        if (def?.business_line && (p.business_line || 'waste') !== def.business_line) continue
        dueIds.add(p.id)
      }
    }
  }

  // Find the route for this date; only create one if there's something to do.
  let { data: route, error: rErr } = await supabase
    .from('routes').select('id').eq('code', code).eq('service_date', date).maybeSingle()
  if (rErr) throw rErr
  if (!dueIds.size && !route) return { added: 0, removed: 0, route: null, noSchedules: true }
  if (!route) route = await ensureRoute(code, date)

  // Current stops, with each property's schedule + work status.
  const { data: existing, error: eErr } = await supabase
    .from('route_stops')
    .select('id, property_id, seq, status, properties(pickup_days)')
    .eq('route_id', route.id)
  if (eErr) throw eErr
  const existingRows = existing || []

  // Remove PENDING recurring stops that aren't due today.
  const removeRows = existingRows.filter((r) => {
    if (r.status !== 'pending') return false              // keep in-progress / done
    const days = r.properties?.pickup_days || []
    if (!days.length) return false                        // keep one-offs / unscheduled
    return !dueIds.has(r.property_id)                      // recurring but not due today
  })
  if (removeRows.length) {
    const { error } = await supabase.from('route_stops').delete().in('id', removeRows.map((r) => r.id))
    if (error) throw error
  }

  // Add due properties not already on the route — and not already placed on
  // ANOTHER route this date (a stop only needs one route for the day).
  const kept = existingRows.filter((r) => !removeRows.includes(r))
  const have = new Set(kept.map((r) => r.property_id))
  let placedElsewhere = new Set()
  const { data: dayRoutes } = await supabase.from('routes').select('id').eq('service_date', date).neq('id', route.id)
  if (dayRoutes && dayRoutes.length) {
    const { data: dayStops } = await supabase.from('route_stops').select('property_id').in('route_id', dayRoutes.map((r) => r.id))
    placedElsewhere = new Set((dayStops || []).map((s) => s.property_id))
  }
  const addIds = [...dueIds].filter((id) => !have.has(id) && !placedElsewhere.has(id))
  let added = 0
  if (addIds.length) {
    const { data: props, error: pErr } = await supabase
      .from('properties').select('id, service, lat, lng').in('id', addIds)
    if (pErr) throw pErr
    let seq = kept.reduce((m, r) => Math.max(m, r.seq || 0), 0)
    const rows = (props || []).map((p) => ({
      route_id: route.id, property_id: p.id, seq: ++seq,
      status: 'pending', service: p.service || null, lat: p.lat, lng: p.lng,
    }))
    if (rows.length) {
      const { error } = await supabase.from('route_stops').insert(rows)
      if (error) throw error
      added = rows.length
    }
  }
  return { added, removed: removeRows.length, route }
}

// --- driver assignment -----------------------------------------------------

// Display name for a driver profile (full name, else email).
async function driverDisplayName(driverId) {
  if (!driverId) return null
  const { data } = await supabase
    .from('profiles').select('full_name, email').eq('id', driverId).maybeSingle()
  return data ? (data.full_name || data.email || null) : null
}

// Assign (or clear, driverId=null) the driver for one date's route. Creates the
// route row for that date if it doesn't exist yet. Keeps the legacy `driver`
// text column in sync for display / mobile reads.
export async function assignDriver(code, date, driverId) {
  const driverName = await driverDisplayName(driverId)

  let rq = supabase.from('routes').select('id').eq('code', code)
  rq = date ? rq.eq('service_date', date) : rq.is('service_date', null)
  const { data: existing, error: fErr } = await rq.maybeSingle()
  if (fErr) throw fErr

  if (existing?.id) {
    const { error } = await supabase
      .from('routes').update({ driver_id: driverId, driver: driverName }).eq('id', existing.id)
    if (error) throw error
    return { routeId: existing.id, driverName }
  }
  const { data: r, error } = await supabase
    .from('routes')
    .insert({ code, name: `Route ${code}`, service_date: date, driver_id: driverId, driver: driverName })
    .select('id').single()
  if (error) throw error
  return { routeId: r.id, driverName }
}

// Carry-forward default driver per route code (route_defaults table).
export async function getRouteDefault(code) {
  const { data, error } = await supabase
    .from('route_defaults').select('driver_id').eq('code', code).maybeSingle()
  if (error) throw error
  return data?.driver_id || null
}

export async function setRouteDefault(code, driverId) {
  const { error } = await supabase
    .from('route_defaults')
    .upsert({ code, driver_id: driverId, updated_at: new Date().toISOString() }, { onConflict: 'code' })
  if (error) throw error
}

// --- route catalog (the set of routes the business runs) --------------------
// route_defaults doubles as the catalog: one row per route code, with its
// carry-forward default driver (driver_id) plus name/color/sort.
export async function loadRouteDefs(line) {
  let q = supabase
    .from('route_defaults')
    .select('code, name, color, driver_id, active, sort, business_line')
    .eq('active', true)
  if (line) q = q.eq('business_line', line)
  const { data, error } = await q
    .order('sort', { ascending: true })
    .order('code', { ascending: true })
  if (error) throw error
  return (data || []).map((d) => ({ ...d, name: d.name || `Route ${d.code}` }))
}

// Every route code in the catalog, across ALL business lines — codes are
// globally unique, so the add-route suggestion must avoid other lines' codes.
export async function loadUsedRouteCodes() {
  const { data, error } = await supabase.from('route_defaults').select('code')
  if (error) throw error
  return (data || []).map((r) => r.code)
}

export async function updateRouteDef(code, patch) {
  const fields = {}
  for (const k of ['name', 'color', 'active', 'sort']) if (patch[k] !== undefined) fields[k] = patch[k]
  fields.updated_at = new Date().toISOString()
  const { error } = await supabase.from('route_defaults').update(fields).eq('code', code)
  if (error) throw error
}

// Delete a whole route: its dated instances and their stops, plus the catalog
// row. Properties are untouched. Everything removed is snapshotted server-side,
// so the returned snapshot_id can undo the deletion via restoreRouteSnapshot.
export async function deleteRouteDef(code, deletedBy = null) {
  const { data, error } = await supabase.rpc('delete_route', { p_code: code, p_deleted_by: deletedBy })
  if (error) throw error
  return data // { code, name, routes_deleted, stops_deleted, snapshot_id }
}

// Undo an accidental route deletion (restores catalog row, dated routes, and
// stops with their original ids).
export async function restoreRouteSnapshot(snapshotId) {
  const { data, error } = await supabase.rpc('restore_route', { p_snapshot_id: snapshotId })
  if (error) throw error
  return data
}

// --- one-time day changes ---------------------------------------------------
// property_day_overrides: on skip_date the property does NOT run its usual
// pickup; on service_date it runs instead. Used by the "just this once" option
// when editing a stop's day.
export async function loadDayOverrides(date) {
  const { data, error } = await supabase
    .from('property_day_overrides')
    .select('id, property_id, skip_date, service_date, note, created_by')
    .or(`skip_date.eq.${date},service_date.eq.${date}`)
  if (error) throw error
  const skips = new Set()
  const extras = new Set()
  for (const r of data || []) {
    if (r.skip_date === date) skips.add(r.property_id)
    if (r.service_date === date) extras.add(r.property_id)
  }
  return { skips, extras, rows: data || [] }
}

export async function createDayOverride({ propertyId, skipDate = null, serviceDate = null, note = null, createdBy = null }) {
  const { data, error } = await supabase
    .from('property_day_overrides')
    .insert({ property_id: propertyId, skip_date: skipDate, service_date: serviceDate, note, created_by: createdBy })
    .select('id')
    .single()
  if (error) throw error
  return data
}

// Move a stop to ANOTHER DATE's route of the same (or another) code — used by
// the one-time day change. Creates the target date's route if needed.
export async function moveStopToDate(stopId, code, targetDate) {
  const target = await ensureRoute(code, targetDate)
  const { data: existing } = await supabase.from('route_stops').select('seq').eq('route_id', target.id)
  const seq = (existing || []).reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1
  const { error } = await supabase.from('route_stops').update({ route_id: target.id, seq }).eq('id', stopId)
  if (error) throw error
  return { route: target }
}

export async function createRouteDef({ code, name, color, line }) {
  const c = String(code || '').trim().toUpperCase()
  if (!c) throw new Error('A route code is required.')
  const { data, error } = await supabase
    .from('route_defaults')
    .insert({ code: c, name: (name && name.trim()) || `Route ${c}`, color: color || null, business_line: line || 'waste' })
    .select('code, name, color, driver_id, active, sort')
    .single()
  if (error) {
    if (error.code === '23505') throw new Error(`Route code ${c} is already taken — codes are shared across business lines (it may be a route on another line). Pick a different code.`)
    throw error
  }
  return data
}

// Copy the most recent prior route of the same code that fell on the SAME
// weekday (e.g. last Monday onto this Monday). Skips stops already present.
export async function copyPreviousWeekday(code, date) {
  if (!date) throw new Error('A date is required.')
  const dow = parseDate(date).getDay()
  const { data: prior, error } = await supabase
    .from('routes')
    .select('id, service_date')
    .eq('code', code)
    .lt('service_date', date)
    .not('service_date', 'is', null)
    .order('service_date', { ascending: false })
    .limit(60)
  if (error) throw error
  const match = (prior || []).find((r) => parseDate(r.service_date).getDay() === dow)
  if (!match) return { copied: 0, noSource: true }

  const { data: srcStops, error: sErr } = await supabase
    .from('route_stops')
    .select('property_id, service, time_window, lat, lng, seq')
    .eq('route_id', match.id)
    .order('seq', { ascending: true })
  if (sErr) throw sErr
  if (!srcStops || !srcStops.length) return { copied: 0, sourceDate: match.service_date }

  const route = await ensureRoute(code, date)
  const { data: existing } = await supabase.from('route_stops').select('property_id, seq').eq('route_id', route.id)
  const have = new Set((existing || []).map((e) => e.property_id))
  let seq = (existing || []).reduce((m, e) => Math.max(m, e.seq || 0), 0)
  const rows = srcStops
    .filter((s) => !have.has(s.property_id))
    .map((s) => ({
      route_id: route.id, property_id: s.property_id, seq: ++seq, status: 'pending',
      service: s.service, time_window: s.time_window, lat: s.lat, lng: s.lng,
    }))
  if (rows.length) {
    const { error: iErr } = await supabase.from('route_stops').insert(rows)
    if (iErr) throw iErr
  }
  return { copied: rows.length, sourceDate: match.service_date }
}

// Every service property with its owning customer — powers the mass-add picker.
// Pass the active business line so lawn dispatch only offers lawn properties.
export async function loadAllProperties(line) {
  let q = supabase
    .from('properties')
    .select('id, name, address, service, lat, lng, needs_review, customer_id, customers(name)')
    .eq('paused', false) // can't hand-add a paused address to a route
  if (line) q = q.eq('business_line', line)
  const { data, error } = await q.order('name', { ascending: true })
  if (error) throw error
  return (data || []).map((p) => ({
    id: p.id, name: p.name, address: p.address || '', service: p.service || '',
    lat: p.lat, lng: p.lng, needsReview: !!p.needs_review, customerId: p.customer_id, customerName: p.customers?.name || '',
  }))
}

// Every route that has stops on this date (with done counts) — powers the
// "Route B ran this day" hint when the selected route shows empty, and the
// "copy another route's day here" picker for alternate/backup routes.
export async function loadDayRouteSummaries(date, line = null) {
  if (!date) return []
  let q = supabase
    .from('routes')
    .select('id, code, name, driver_id, route_stops(status)')
    .eq('service_date', date)
  if (line) q = q.eq('business_line', line)
  const { data, error } = await q.order('code', { ascending: true })
  if (error) throw error
  return (data || [])
    .filter((r) => (r.route_stops || []).length > 0)
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name || `Route ${r.code}`,
      driverId: r.driver_id,
      stops: r.route_stops.length,
      done: r.route_stops.filter((s) => s.status === 'done').length,
    }))
}

// Copy ANOTHER route's stops for the same date onto this route — the one-click
// way to build an alternate/backup route (same addresses, own stop order, own
// driver). Properties already on the target route are skipped.
export async function copyRouteStopsToDate(fromCode, toCode, date) {
  if (!date) throw new Error('A date is required.')
  const { data: src } = await supabase
    .from('routes').select('id').eq('code', fromCode).eq('service_date', date).maybeSingle()
  if (!src) return { copied: 0, noSource: true }
  const { data: srcStops, error } = await supabase
    .from('route_stops')
    .select('property_id, service, time_window, lat, lng, seq')
    .eq('route_id', src.id)
    .order('seq', { ascending: true })
  if (error) throw error
  if (!srcStops || !srcStops.length) return { copied: 0, noSource: true }

  const target = await ensureRoute(toCode, date)
  const { data: existing } = await supabase.from('route_stops').select('property_id, seq').eq('route_id', target.id)
  const have = new Set((existing || []).map((e) => e.property_id))
  let seq = (existing || []).reduce((m, e) => Math.max(m, e.seq || 0), 0)
  const rows = srcStops
    .filter((s) => !have.has(s.property_id))
    .map((s) => ({
      route_id: target.id, property_id: s.property_id, seq: ++seq, status: 'pending',
      service: s.service, time_window: s.time_window, lat: s.lat, lng: s.lng,
    }))
  if (rows.length) {
    const { error: iErr } = await supabase.from('route_stops').insert(rows)
    if (iErr) throw iErr
  }
  return { copied: rows.length, sourceCode: fromCode, route: target }
}

// Append many properties to a date's route in one shot (skips ones already on it).
export async function addPropertiesToRoute(code, date, props) {
  const list = (props || []).filter(Boolean)
  if (!list.length) return { added: 0 }
  const route = await ensureRoute(code, date)
  const { data: existing, error: eErr } = await supabase
    .from('route_stops').select('property_id, seq').eq('route_id', route.id)
  if (eErr) throw eErr
  const have = new Set((existing || []).map((e) => e.property_id))
  let seq = (existing || []).reduce((m, e) => Math.max(m, e.seq || 0), 0)
  const rows = list
    .filter((p) => !have.has(p.id))
    .map((p) => ({ route_id: route.id, property_id: p.id, seq: ++seq, status: 'pending', service: p.service || null, lat: p.lat, lng: p.lng }))
  let ids = []
  if (rows.length) {
    const { data, error } = await supabase.from('route_stops').insert(rows).select('id')
    if (error) throw error
    ids = (data || []).map((r) => r.id)
  }
  return { added: rows.length, route, ids }
}

// ---- plan-mode day reset + undo --------------------------------------------
// Wipe EVERY stop (any status) off one route for one date. Returns the full
// rows (+ their photos, which the FK cascades away on delete) so the caller
// can offer undo by re-inserting them verbatim. Already-invoiced lines are
// untouched: invoice_line_items.stop_id is ON DELETE SET NULL, so the line
// survives detached rather than being destroyed.
export async function resetRouteDay(routeId) {
  const { data: stops, error } = await supabase
    .from('route_stops').select('*').eq('route_id', routeId)
  if (error) throw error
  if (!stops || !stops.length) return { removed: [], photos: [] }
  const ids = stops.map((r) => r.id)
  const { data: photos, error: pErr } = await supabase
    .from('stop_photos').select('*').in('stop_id', ids)
  if (pErr) throw pErr
  const { error: dErr } = await supabase.from('route_stops').delete().in('id', ids)
  if (dErr) throw dErr
  return { removed: stops, photos: photos || [] }
}

// Undo for resetRouteDay: re-insert the captured rows with their original ids
// (so photos re-attach and links stay stable). Stops first, photos second —
// the photo FK needs its stop back before it can point at it.
export async function restoreDay({ stops, photos = [] }) {
  if (!stops || !stops.length) return
  const { error } = await supabase.from('route_stops').insert(stops)
  if (error) {
    if (error.code === '23505') throw new Error('Those stops are already back on the route — nothing to restore.')
    throw error
  }
  if (photos.length) {
    const { error: pErr } = await supabase.from('stop_photos').insert(photos)
    if (pErr && pErr.code !== '23505') throw pErr
  }
}

// Undo for planning adds: remove stops by id (no-op rows are fine — the stop
// may already have been removed or moved by hand).
export async function removeStopsByIds(ids) {
  if (!ids || !ids.length) return
  const { error } = await supabase.from('route_stops').delete().in('id', ids)
  if (error) throw error
}

// All routes (with their stops + driver) for a single date — powers the
// Drivers & Field per-driver dispatch board.
export async function loadDayDispatch(date, line) {
  if (!date) throw new Error('A date is required.')
  let q = supabase
    .from('routes')
    .select('id, code, name, driver_id, business_line, route_stops(id, seq, status, service, time_window, lat, lng, check_in, check_out, on_my_way_at, excess_flagged, excess_note, tech_pay, nudge_sent, skip_reason, skipped_by, property_id, job_title, job_description, job_price, properties(name, address, notes, lat, lng, price, tech_pay, customer_id, customers(name, phone, notify_on_service, customer_tags(tag:tags(id,name,color)))), stop_photos(id))')
    .eq('service_date', date)
  if (line) q = q.eq('business_line', line)
  const { data, error } = await q.order('code', { ascending: true })
  if (error) throw error
  return (data || []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name || `Route ${r.code}`,
    line: r.business_line || 'waste',
    driverId: r.driver_id,
    stops: (r.route_stops || [])
      .slice()
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
      .map((s) => ({
        id: s.id, seq: s.seq, status: s.status, service: s.service, window: s.time_window,
        lat: s.properties?.lat ?? s.lat, lng: s.properties?.lng ?? s.lng, checkIn: s.check_in, checkOut: s.check_out,
        name: s.properties?.name || '—', address: s.properties?.address || '',
        notes: s.properties?.notes || '',
        clientName: s.properties?.customers?.name || null,
        clientPhone: s.properties?.customers?.phone || null,
        notifyOnService: s.properties?.customers?.notify_on_service !== false, // false = opted out of visit notices
        tags: tagsOf(s.properties?.customers),
        customerId: s.properties?.customer_id || null,
        propertyId: s.property_id || null,
        skipReason: s.skip_reason || '',
        skippedBy: s.skipped_by || null,
        onMyWayAt: s.on_my_way_at || null,
        excessFlagged: !!s.excess_flagged, excessNote: s.excess_note || '',
        nudgeSent: !!s.nudge_sent,
        photoCount: (s.stop_photos || []).length,
        techPay: s.tech_pay ?? s.properties?.tech_pay ?? null,
        price: s.properties?.price ?? null,
        jobTitle: s.job_title || null,
        jobDescription: s.job_description || null,
        jobPrice: s.job_price != null ? Number(s.job_price) : null,
      })),
  }))
}

// Routes (with their stops) across a DATE RANGE — powers the "My Schedule"
// week/month calendar. Optionally filtered to one driver and/or business line.
export async function loadScheduleRange(startDate, endDate, { driverId, line } = {}) {
  let q = supabase
    .from('routes')
    .select('id, code, name, service_date, driver_id, business_line, route_stops(id, status, service, check_out, properties(address, name))')
    .gte('service_date', startDate)
    .lte('service_date', endDate)
  if (driverId) q = q.eq('driver_id', driverId)
  if (line) q = q.eq('business_line', line)
  const { data, error } = await q.order('service_date', { ascending: true })
  if (error) throw error
  return (data || []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name || `Route ${r.code}`,
    date: r.service_date,
    driverId: r.driver_id,
    line: r.business_line || 'waste',
    stops: (r.route_stops || []).map((s) => ({
      id: s.id,
      status: s.status,
      done: !!s.check_out,
      service: s.service || '',
      address: s.properties?.address || s.properties?.name || '',
    })),
  }))
}

// Admin override: pay the tech for a stop that's missing photos/check-out.
// Recorded (who + when) so timesheets show the approval trail.
export async function overrideStopPay(stopId, adminName) {
  const { error } = await supabase.from('route_stops').update({
    pay_override: true,
    pay_override_by: adminName || 'Admin',
    pay_override_at: new Date().toISOString(),
  }).eq('id', stopId)
  if (error) throw error
}

export async function markStopNudged(stopId) {
  await supabase.from('route_stops').update({ nudge_sent: true }).eq('id', stopId)
}

// "On my way" — stamps the stop (button shows once) and lets My Day text the client.
export async function markStopOnMyWay(stopId) {
  const { error } = await supabase.from('route_stops').update({ on_my_way_at: new Date().toISOString() }).eq('id', stopId)
  if (error) throw error
}

// Driver flags a pickup as excessive (over the usual volume). Starts the
// review flow: Randy drafts an extra invoice line, an admin approves, and the
// customer sees the flag (and approved charge) in their portal.
export async function flagStopExcess(stopId, note) {
  const { error } = await supabase.from('route_stops').update({
    excess_flagged: true,
    excess_note: (note || '').trim() || null,
    excess_status: 'pending',
  }).eq('id', stopId)
  if (error) throw error
}

export async function unflagStopExcess(stopId) {
  const { error } = await supabase.from('route_stops').update({
    excess_flagged: false, excess_note: null, excess_status: null,
    excess_amount: null, excess_reviewed_by: null, excess_reviewed_at: null,
  }).eq('id', stopId)
  if (error) throw error
}

// --- field ops: driver check-in / check-out (with best-effort GPS) ----------
export async function checkInStop(stopId, gps) {
  const patch = { status: 'enroute', check_in: new Date().toISOString() }
  if (gps) { patch.check_in_lat = gps.lat; patch.check_in_lng = gps.lng }
  const { error } = await supabase.from('route_stops').update(patch).eq('id', stopId)
  if (error) throw error
}

export async function checkOutStop(stopId, gps) {
  const patch = { status: 'done', check_out: new Date().toISOString() }
  if (gps) { patch.check_out_lat = gps.lat; patch.check_out_lng = gps.lng }
  const { error } = await supabase.from('route_stops').update(patch).eq('id', stopId)
  if (error) throw error
}

// Undo: back to pending and clear the check-in/out trail.
export async function resetStopStatus(stopId) {
  const { error } = await supabase.from('route_stops').update({
    status: 'pending', check_in: null, check_out: null, on_my_way_at: null,
    check_in_lat: null, check_in_lng: null, check_out_lat: null, check_out_lng: null,
  }).eq('id', stopId)
  if (error) throw error
}

// Skip a stop WITHOUT deleting it: flagged with a reason so dispatch can see it
// was intentionally passed over. Un-skip puts it back to pending.
export async function skipStop(stopId, reason, byName) {
  const { error } = await supabase.from('route_stops').update({
    status: 'skipped',
    skip_reason: (reason || '').trim() || null,
    skipped_by: byName || null,
    skipped_at: new Date().toISOString(),
  }).eq('id', stopId)
  if (error) throw error
}

export async function unskipStop(stopId) {
  const { error } = await supabase.from('route_stops').update({
    status: 'pending', skip_reason: null, skipped_by: null, skipped_at: null,
  }).eq('id', stopId)
  if (error) throw error
}

// Move a stop to another route on the same date (creating that route if needed).
// The destination route's driver effectively "takes" the stop.
export async function moveStopToRoute(stopId, targetCode, date) {
  const target = await ensureRoute(targetCode, date)
  const { data: existing } = await supabase.from('route_stops').select('seq').eq('route_id', target.id)
  const seq = (existing || []).reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1
  const { error } = await supabase.from('route_stops').update({ route_id: target.id, seq }).eq('id', stopId)
  if (error) throw error
  return { route: target }
}

export async function removeStopFromRoute(stopId) {
  const { error } = await supabase.from('route_stops').delete().eq('id', stopId)
  if (error) throw error
}

// Get the route for code+date, creating it (with the carry-forward default
// driver) if it doesn't exist yet.
export async function ensureRoute(code, date) {
  let rq = supabase.from('routes').select('id, code, name, driver_id, service_date').eq('code', code)
  rq = date ? rq.eq('service_date', date) : rq.is('service_date', null)
  const { data: route, error } = await rq.maybeSingle()
  if (error) throw error
  if (route) return route
  const defDriver = await getRouteDefault(code).catch(() => null)
  const defName = await driverDisplayName(defDriver)
  // Inherit the business line from the route catalog (codes are line-unique).
  const { data: def } = await supabase.from('route_defaults').select('business_line').eq('code', code).maybeSingle()
  const { data: r, error: cErr } = await supabase
    .from('routes')
    .insert({ code, name: `Route ${code}`, service_date: date, driver_id: defDriver, driver: defName, business_line: def?.business_line || 'waste' })
    .select('id, code, name, driver_id, service_date').single()
  if (cErr) throw cErr
  return r
}

// Add a brand-new ad-hoc stop (a one-off pickup) to a date's route: geocodes
// the address, creates a property for it, and appends it as a stop. Does NOT
// create a recurring schedule — it only lands on this one date's route.
// jobTitle/jobDescription/jobPrice ride on the stop itself (mig 0043) and are
// what the driver's check-in/out "add to invoice" popup bills from.
export async function addOneOffStop(code, date, { name, address, service, customerId, price, jobTitle, jobDescription, jobPrice } = {}) {
  const addr = String(address || '').trim()
  if (!addr) throw new Error('An address is required.')
  if (!date) throw new Error('A date is required.')

  // Best-effort geocode (the stop is still added if it can't be located).
  let loc = null
  try { loc = await geocodeAddress(addr) } catch (e) { loc = null }

  const { data: prop, error: pErr } = await supabase
    .from('properties')
    .insert({
      name: (name && name.trim()) || addr,
      address: addr,
      service: service || null,
      customer_id: customerId || null,
      price: price != null ? price : null,
      lat: loc ? loc.lat : null,
      lng: loc ? loc.lng : null,
    })
    .select('id, name, service, lat, lng').single()
  if (pErr) throw pErr

  const route = await ensureRoute(code, date)
  const { data: existing, error: eErr } = await supabase
    .from('route_stops').select('seq').eq('route_id', route.id)
  if (eErr) throw eErr
  const seq = (existing || []).reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1

  const { data: stop, error: sErr } = await supabase.from('route_stops').insert({
    route_id: route.id,
    property_id: prop.id,
    seq,
    status: 'pending',
    service: service || prop.service || null,
    job_title: (jobTitle && jobTitle.trim()) || null,
    job_description: (jobDescription && jobDescription.trim()) || null,
    job_price: jobPrice != null && !isNaN(Number(jobPrice)) ? Number(jobPrice) : null,
    lat: prop.lat,
    lng: prop.lng,
  }).select('id').single()
  if (sErr) throw sErr

  return { route, property: prop, stopId: stop.id, geocoded: !!loc }
}

// Loose address normalization for CSV matching: lowercase, drop punctuation,
// collapse whitespace. Zips fall away naturally when one side omits them only
// if the shorter string is a prefix of the longer (handled by the matcher).
export function normAddress(a) {
  return String(a || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// Find the best property for a CSV address: exact normalized match first, then
// prefix containment (so "123 Main St" matches "123 Main St, St Augustine FL").
export function matchPropertyByAddress(addr, byAddr) {
  const n = normAddress(addr)
  if (!n) return null
  if (byAddr.has(n)) return byAddr.get(n)
  if (n.length >= 6) {
    for (const [k, v] of byAddr) {
      if (k.length >= 6 && (k.startsWith(n) || n.startsWith(k))) return v
    }
  }
  return null
}

// Import an ordered CSV address list as this date's route. Matched addresses
// are added (if missing) and the route is re-sequenced to the CSV's order —
// stops already on the route that the CSV doesn't mention keep their relative
// order AFTER the imported ones. Unmatched addresses are added anyway as NEW
// review-flagged properties under a new contact named after the address, so
// routing can proceed before the real customer + price exist.
export async function importRouteCsv(code, date, rows, line) {
  if (!date) throw new Error('A date is required.')
  const list = (rows || [])
    .map((r) => ({ address: String(r.address || '').trim(), name: String(r.name || '').trim() }))
    .filter((r) => r.address)
  if (!list.length) throw new Error('No addresses found in the file.')

  const props = await loadAllProperties(line)
  const byAddr = new Map()
  for (const p of props) {
    const n = normAddress(p.address)
    if (n && !byAddr.has(n)) byAddr.set(n, p)
  }

  const resolved = []
  let created = 0
  for (const r of list) {
    let p = matchPropertyByAddress(r.address, byAddr)
    if (!p) {
      // Unknown address: create the contact (named after the address) + a
      // review-flagged property so it still lands on the route.
      let loc = null
      try { loc = await geocodeAddress(r.address) } catch (e) { loc = null }
      const custId = await createClient({ name: r.name || r.address, address: r.address, businessLine: line || 'waste' })
      const { data: np, error } = await supabase
        .from('properties')
        .insert({
          customer_id: custId,
          name: r.name || r.address,
          address: r.address,
          needs_review: true,
          business_line: line || 'waste',
          lat: loc ? loc.lat : null,
          lng: loc ? loc.lng : null,
        })
        .select('id, name, address, service, lat, lng').single()
      if (error) throw error
      p = { id: np.id, name: np.name, address: np.address, service: np.service, lat: np.lat, lng: np.lng }
      created++
    }
    if (!resolved.some((x) => x.id === p.id)) resolved.push(p) // dedupe repeats in the file
  }

  const route = await ensureRoute(code, date)
  const { data: existing, error: eErr } = await supabase
    .from('route_stops')
    .select('id, property_id, seq, service, lat, lng')
    .eq('route_id', route.id)
  if (eErr) throw eErr
  const have = new Map((existing || []).map((s) => [s.property_id, s]))

  const importedIds = new Set(resolved.map((p) => p.id))
  const orderedProps = [
    ...resolved,
    ...(existing || []).filter((s) => !importedIds.has(s.property_id)).map((s) => ({ id: s.property_id })),
  ]
  let seq = 0
  const updates = []
  for (const p of orderedProps) {
    seq++
    if (!have.has(p.id)) {
      const { error } = await supabase.from('route_stops').insert({
        route_id: route.id, property_id: p.id, seq, status: 'pending',
        service: p.service || null, lat: p.lat ?? null, lng: p.lng ?? null,
      })
      if (error) throw error
    } else {
      updates.push({ id: have.get(p.id).id, seq })
    }
  }
  await Promise.all(updates.map((u) => supabase.from('route_stops').update({ seq: u.seq }).eq('id', u.id)))
  return { matched: resolved.length - created, created, total: resolved.length, route }
}

// Live updates: fire cb whenever any stop on this route changes.
export function subscribeRouteStops(routeId, cb) {
  const channel = supabase
    .channel(`route_stops:${routeId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'route_stops', filter: `route_id=eq.${routeId}` },
      cb
    )
    .subscribe()
  return () => supabase.removeChannel(channel)
}


// ---- Day-scoped route combinations ------------------------------------------
// One driver (or two riding together) running two routes: the routes stay
// exactly as planned; a combo row just tells the dispatch board to present
// them as ONE run for that date, with the listed drivers.
export async function loadRouteCombos(date) {
  if (!date) return []
  const { data, error } = await supabase.from('route_combos')
    .select('id, service_date, codes, driver_ids, created_by, created_at')
    .eq('service_date', date).order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map((c) => ({ id: c.id, date: c.service_date, codes: c.codes || [], driverIds: c.driver_ids || [], createdBy: c.created_by }))
}
export async function createRouteCombo(date, codes, driverIds, createdBy = null) {
  const cs = [...new Set((codes || []).map((c) => String(c).toUpperCase()))]
  if (cs.length < 2) throw new Error('Pick at least two routes to combine.')
  // A route can only be in one combo per day — fold into an existing one if overlapping.
  const existing = await loadRouteCombos(date)
  const hit = existing.find((c) => c.codes.some((x) => cs.includes(x)))
  if (hit) {
    const merged = [...new Set([...hit.codes, ...cs])]
    const drivers = [...new Set([...(hit.driverIds || []), ...(driverIds || [])].filter(Boolean))]
    const { error } = await supabase.from('route_combos').update({ codes: merged, driver_ids: drivers }).eq('id', hit.id)
    if (error) throw error
    return { ...hit, codes: merged, driverIds: drivers }
  }
  const { data, error } = await supabase.from('route_combos')
    .insert({ service_date: date, codes: cs, driver_ids: (driverIds || []).filter(Boolean), created_by: createdBy })
    .select('id').single()
  if (error) throw error
  return { id: data.id, date, codes: cs, driverIds: (driverIds || []).filter(Boolean) }
}
export async function updateRouteComboDrivers(id, driverIds) {
  const { error } = await supabase.from('route_combos').update({ driver_ids: (driverIds || []).filter(Boolean) }).eq('id', id)
  if (error) throw error
}
export async function deleteRouteCombo(id) {
  const { error } = await supabase.from('route_combos').delete().eq('id', id)
  if (error) throw error
}
// Group a day's routes by combo: [{ key, combo|null, routes:[...] , driverIds:[...] }].
// Routes not in any combo come back as single-route groups.
export function groupRoutesByCombo(routes, combos) {
  const used = new Set()
  const groups = []
  for (const c of combos || []) {
    const rts = (c.codes || []).map((code) => routes.find((r) => r.code === code)).filter(Boolean)
    rts.forEach((r) => used.add(r.id))
    const driverIds = (c.driverIds && c.driverIds.length) ? c.driverIds : [...new Set(rts.map((r) => r.driverId).filter(Boolean))]
    groups.push({ key: 'combo:' + c.id, combo: c, routes: rts, driverIds, codes: c.codes || [] })
  }
  for (const r of routes) {
    if (used.has(r.id)) continue
    groups.push({ key: 'route:' + r.id, combo: null, routes: [r], driverIds: r.driverId ? [r.driverId] : [], codes: [r.code] })
  }
  return groups
}
