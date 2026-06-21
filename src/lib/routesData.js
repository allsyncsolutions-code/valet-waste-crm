// Data layer for the routes slice — all Supabase reads/writes live here so the
// views stay declarative. route_stops is the single source of truth shared by
// dispatch and the driver view.
import { supabase } from './supabaseClient.js'
import { loadSettings, settingsDepot, geocodeAddress } from './settingsData.js'

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

export async function loadActiveSchedules() {
  const { data, error } = await supabase
    .from('pickup_schedules')
    .select('customer_id, day_of_week, frequency, start_date, active')
    .eq('active', true)
  if (error) throw error
  return data || []
}

// DB row (with joined property) -> the shape the UI uses.
function mapStop(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    seq: row.seq,
    status: row.status,
    service: row.service || row.properties?.service || '',
    window: row.time_window || '',
    lat: row.lat ?? row.properties?.lat,
    lng: row.lng ?? row.properties?.lng,
    name: row.properties?.name || 'Unknown',
  }
}

// Load one route's depot, ordered stops, and the unrouted properties.
// A route is identified by code + service_date, so each day has its own route.
export async function loadRouteSlice(code = 'B', date = null) {
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
    .select('id, property_id, seq, status, service, time_window, lat, lng, properties(name, service, lat, lng)')
    .eq('route_id', route.id)
    .order('seq', { ascending: true })
  if (sErr) throw sErr
  const stops = stopRows.map(mapStop)

  const { data: props, error: pErr } = await supabase
    .from('properties')
    .select('id, name, service, lat, lng')
  if (pErr) throw pErr

  const onRoute = new Set(stops.map((s) => s.propertyId))
  const unrouted = props
    .filter((p) => !onRoute.has(p.id))
    .map((p) => ({
      id: `prop:${p.id}`,
      propertyId: p.id,
      name: p.name,
      service: p.service || '',
      window: '',
      lat: p.lat,
      lng: p.lng,
      status: 'pending',
    }))

  const depot = route.depot_lat != null
    ? { name: route.depot_name || homeDepot.name, lat: route.depot_lat, lng: route.depot_lng }
    : homeDepot
  return { route, depot, stops, unrouted }
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

// Populate the route FOR A SPECIFIC DATE from recurring schedules: every
// property whose client has a schedule that lands on `date` (weekday + start
// date + frequency) is added as a stop, skipping any already on the route.
export async function buildRouteFromSchedules(code = 'B', date = null) {
  if (!date) throw new Error('A date is required.')

  // Which clients are due on this date?
  const scheds = await loadActiveSchedules()
  const due = scheds.filter((s) => scheduleHitsDate(s, date))
  const custIds = [...new Set(due.map((s) => s.customer_id).filter(Boolean))]
  if (!custIds.length) return { added: 0, route: null, noSchedules: true }

  // Ensure the route for this date exists.
  let { data: route, error: rErr } = await supabase
    .from('routes').select('id, code, name').eq('code', code).eq('service_date', date).maybeSingle()
  if (rErr) throw rErr
  if (!route) {
    // Carry the remembered default driver forward onto this new date's route.
    const defDriver = await getRouteDefault(code).catch(() => null)
    const defName = await driverDisplayName(defDriver)
    const { data: r, error } = await supabase
      .from('routes')
      .insert({ code, name: `Route ${code}`, service_date: date, driver_id: defDriver, driver: defName })
      .select('id, code, name').single()
    if (error) throw error
    route = r
  }

  // Their properties.
  const { data: props, error: pErr } = await supabase
    .from('properties').select('id, service, lat, lng').in('customer_id', custIds)
  if (pErr) throw pErr

  // Skip properties already on the route; append the rest.
  const { data: existing, error: eErr } = await supabase
    .from('route_stops').select('property_id, seq').eq('route_id', route.id)
  if (eErr) throw eErr
  const have = new Set((existing || []).map((e) => e.property_id))
  let seq = (existing || []).reduce((m, e) => Math.max(m, e.seq || 0), 0)
  const toAdd = (props || []).filter((p) => !have.has(p.id))
  if (toAdd.length) {
    const rows = toAdd.map((p) => ({
      route_id: route.id, property_id: p.id, seq: ++seq,
      status: 'pending', service: p.service || null, lat: p.lat, lng: p.lng,
    }))
    const { error } = await supabase.from('route_stops').insert(rows)
    if (error) throw error
  }
  return { added: toAdd.length, route }
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
export async function loadRouteDefs() {
  const { data, error } = await supabase
    .from('route_defaults')
    .select('code, name, color, driver_id, active, sort')
    .eq('active', true)
    .order('sort', { ascending: true })
    .order('code', { ascending: true })
  if (error) throw error
  return (data || []).map((d) => ({ ...d, name: d.name || `Route ${d.code}` }))
}

export async function updateRouteDef(code, patch) {
  const fields = {}
  for (const k of ['name', 'color', 'active', 'sort']) if (patch[k] !== undefined) fields[k] = patch[k]
  fields.updated_at = new Date().toISOString()
  const { error } = await supabase.from('route_defaults').update(fields).eq('code', code)
  if (error) throw error
}

export async function createRouteDef({ code, name, color }) {
  const c = String(code || '').trim().toUpperCase()
  if (!c) throw new Error('A route code is required.')
  const { data, error } = await supabase
    .from('route_defaults')
    .insert({ code: c, name: (name && name.trim()) || `Route ${c}`, color: color || null })
    .select('code, name, color, driver_id, active, sort')
    .single()
  if (error) {
    if (error.code === '23505') throw new Error(`Route ${c} already exists.`)
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
export async function loadAllProperties() {
  const { data, error } = await supabase
    .from('properties')
    .select('id, name, address, service, lat, lng, customer_id, customers(name)')
    .order('name', { ascending: true })
  if (error) throw error
  return (data || []).map((p) => ({
    id: p.id, name: p.name, address: p.address || '', service: p.service || '',
    lat: p.lat, lng: p.lng, customerId: p.customer_id, customerName: p.customers?.name || '',
  }))
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
  if (rows.length) {
    const { error } = await supabase.from('route_stops').insert(rows)
    if (error) throw error
  }
  return { added: rows.length, route }
}

// All routes (with their stops + driver) for a single date — powers the
// Drivers & Field per-driver dispatch board.
export async function loadDayDispatch(date) {
  if (!date) throw new Error('A date is required.')
  const { data, error } = await supabase
    .from('routes')
    .select('id, code, name, driver_id, route_stops(id, seq, status, service, time_window, lat, lng, properties(name, address))')
    .eq('service_date', date)
    .order('code', { ascending: true })
  if (error) throw error
  return (data || []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name || `Route ${r.code}`,
    driverId: r.driver_id,
    stops: (r.route_stops || [])
      .slice()
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
      .map((s) => ({
        id: s.id, seq: s.seq, status: s.status, service: s.service, window: s.time_window,
        lat: s.lat, lng: s.lng, name: s.properties?.name || '—', address: s.properties?.address || '',
      })),
  }))
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
  const { data: r, error: cErr } = await supabase
    .from('routes')
    .insert({ code, name: `Route ${code}`, service_date: date, driver_id: defDriver, driver: defName })
    .select('id, code, name, driver_id, service_date').single()
  if (cErr) throw cErr
  return r
}

// Add a brand-new ad-hoc stop (a one-off pickup) to a date's route: geocodes
// the address, creates a property for it, and appends it as a stop. Does NOT
// create a recurring schedule — it only lands on this one date's route.
export async function addOneOffStop(code, date, { name, address, service, customerId, price } = {}) {
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

  const { error: sErr } = await supabase.from('route_stops').insert({
    route_id: route.id,
    property_id: prop.id,
    seq,
    status: 'pending',
    service: service || prop.service || null,
    lat: prop.lat,
    lng: prop.lng,
  })
  if (sErr) throw sErr

  return { route, property: prop, geocoded: !!loc }
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
