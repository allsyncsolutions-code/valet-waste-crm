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
