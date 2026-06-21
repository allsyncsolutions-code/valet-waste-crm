// Data layer for the routes slice — all Supabase reads/writes live here so the
// views stay declarative. route_stops is the single source of truth shared by
// dispatch and the driver view.
import { supabase } from './supabaseClient.js'
import { loadSettings, settingsDepot } from './settingsData.js'

const DEFAULT_DEPOT = { name: 'AllSync Yard', lat: 44.804, lng: -93.278 }

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
export async function loadRouteSlice(code = 'B') {
  // The configured starting location (Settings) is the map home + optimizer
  // start, unless a specific route overrides it with its own depot.
  const settings = await loadSettings().catch(() => null)
  const homeDepot = settingsDepot(settings) || DEFAULT_DEPOT

  const { data: route, error: rErr } = await supabase
    .from('routes')
    .select('*')
    .eq('code', code)
    .maybeSingle()
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

// Populate a route from recurring schedules: every property whose client has
// an active pickup schedule (optionally for a given weekday) is added as a
// stop, skipping any already on the route. Returns how many were added.
export async function buildRouteFromSchedules(code = 'B', day = null) {
  // Ensure the route exists.
  let { data: route, error: rErr } = await supabase
    .from('routes').select('id, code, name').eq('code', code).maybeSingle()
  if (rErr) throw rErr
  if (!route) {
    const { data: r, error } = await supabase
      .from('routes').insert({ code, name: `Route ${code}` }).select('id, code, name').single()
    if (error) throw error
    route = r
  }

  // Clients with an active schedule (optionally only the given weekday).
  let sq = supabase.from('pickup_schedules').select('customer_id').eq('active', true)
  if (day) sq = sq.eq('day_of_week', day)
  const { data: scheds, error: sErr } = await sq
  if (sErr) throw sErr
  const custIds = [...new Set((scheds || []).map((s) => s.customer_id).filter(Boolean))]
  if (!custIds.length) return { added: 0, route, noSchedules: true }

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

export async function removeStopFromRoute(stopId) {
  const { error } = await supabase.from('route_stops').delete().eq('id', stopId)
  if (error) throw error
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
