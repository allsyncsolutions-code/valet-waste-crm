// Route data model — the single source of truth shared by dispatch + driver.
//
// This mirrors the future Supabase table `route_stops`. When the backend lands,
// these seed arrays get replaced by Supabase reads/writes and the helpers below
// operate on the same shape. Dispatch writes the order; the driver view
// subscribes (Supabase Realtime) and reads it — no other change needed.
//
//   -- Supabase schema (for reference, build later):
//   create table route_stops (
//     id          uuid primary key default gen_random_uuid(),
//     route_id    uuid references routes(id),
//     property_id uuid references properties(id),
//     seq         int  not null,            -- 1-based visit order
//     status      text not null default 'pending', -- done | enroute | pending
//     name        text,                     -- denormalized for display
//     service     text,                     -- e.g. "4yd dumpster x2"
//     window      text,                     -- requested time window
//     lat         double precision,
//     lng         double precision,
//     check_in    timestamptz,
//     check_out   timestamptz,
//     created_at  timestamptz default now()
//   );

// Truck yard / depot the route starts from.
export const DEPOT = { name: 'AllSync Yard', lat: 44.804, lng: -93.278 }

// Stops already assigned to today's route (deliberately out of optimal order so
// "Optimize" visibly improves it). status: done | enroute | pending.
export const ROUTE_STOPS_SEED = [
  { id: 's1', propertyId: 'p-lakeside', name: 'Lakeside Café', service: '2x 96gal toter - recycling', window: '7:05a', lat: 44.812, lng: -93.165, status: 'done' },
  { id: 's2', propertyId: 'p-maple', name: 'Maple Grove Apartments', service: '4yd dumpster x2', window: '7:30a', lat: 44.825, lng: -93.185, status: 'done' },
  { id: 's3', propertyId: 'p-sunrise', name: 'Sunrise Medical Center', service: '8yd - gate code 4417', window: '9:30a', lat: 44.858, lng: -93.150, status: 'enroute' },
  { id: 's4', propertyId: 'p-oakwood', name: 'Oakwood HOA - Clubhouse', service: '4yd dumpster', window: '10:10a', lat: 44.870, lng: -93.230, status: 'pending' },
  { id: 's5', propertyId: 'p-riverside', name: 'Riverside Diner', service: '2yd dumpster - grease pen', window: '8:10a', lat: 44.833, lng: -93.195, status: 'pending' },
  { id: 's6', propertyId: 'p-pinecrest', name: 'Pinecrest School', service: '2x 6yd dumpster', window: '10:45a', lat: 44.880, lng: -93.190, status: 'pending' },
  { id: 's7', propertyId: 'p-birchwood', name: 'Birchwood Townhomes', service: '6yd dumpster', window: '8:45a', lat: 44.845, lng: -93.205, status: 'pending' },
  { id: 's8', propertyId: 'p-northgate', name: 'Northgate Retail Park', service: '4yd dumpster', window: '11:15a', lat: 44.815, lng: -93.255, status: 'pending' },
]

// Stops requested but not yet placed on a route (e.g. portal extra-pickup).
export const UNROUTED_SEED = [
  { id: 'u1', propertyId: 'p-cedar', name: 'Cedar Industrial (extra)', service: '20yd roll-off', window: 'req 9:02a', lat: 44.862, lng: -93.270, status: 'pending' },
  { id: 'u2', propertyId: 'p-summit', name: 'Summit Plaza', service: '6yd dumpster', window: 'req 9:40a', lat: 44.840, lng: -93.140, status: 'pending' },
]

export const STATUS_META = {
  done: { label: 'DONE', color: '#1f7a4d', bg: '#1f7a4d', fg: '#fff' },
  enroute: { label: 'ON SITE', color: '#c08a2e', bg: '#173d2a', fg: '#fff' },
  pending: { label: 'PENDING', color: '#5d6b63', bg: '#eef0ed', fg: '#5d6b63' },
}

// Stops whose order is locked (already visited / currently being serviced).
export const isFixed = (s) => s.status === 'done' || s.status === 'enroute'

// Assign 1-based seq numbers in array order. Returns a new array.
export function resequence(stops) {
  return stops.map((s, i) => ({ ...s, seq: i + 1 }))
}

// Split a route into the locked prefix and the movable (pending) tail.
export function splitFixed(stops) {
  const fixed = []
  const movable = []
  let stillFixed = true
  for (const s of stops) {
    if (stillFixed && isFixed(s)) fixed.push(s)
    else {
      stillFixed = false
      movable.push(s)
    }
  }
  return { fixed, movable }
}

// Move a movable stop up/down without crossing into the locked prefix.
export function moveStop(stops, id, dir) {
  const { fixed, movable } = splitFixed(stops)
  const i = movable.findIndex((s) => s.id === id)
  if (i < 0) return stops
  const j = i + dir
  if (j < 0 || j >= movable.length) return stops
  const next = movable.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return resequence([...fixed, ...next])
}

export function removeStop(stops, id) {
  return resequence(stops.filter((s) => s.id !== id))
}

export function addStop(stops, stop) {
  return resequence([...stops, { ...stop, status: 'pending' }])
}
