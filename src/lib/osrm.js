// OSRM client — free, keyless road routing (same open-data stack as the OSM
// map tiles; no API key to manage, like the Census/Nominatim geocoders).
//   fetchRoadPath(points)   -> road geometry for the whole ordered route
//   fetchDriveMatrix(points)-> driving times/distances between every pair
// The public demo server is community-hosted with no SLA, so every caller MUST
// treat failure/timeouts as normal and fall back to the straight-line
// heuristic in geo.js. Swapping OSRM_BASE to a dedicated/self-hosted endpoint
// later touches nothing else.

import { hasCoords } from './geo.js'

const OSRM_BASE = 'https://router.project-osrm.org'
const TIMEOUT_MS = 7000

function coordString(points) {
  return points.map((p) => `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`).join(';')
}

async function osrm(path) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${OSRM_BASE}${path}`, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`)
    const j = await r.json()
    if (j.code !== 'Ok') throw new Error(`OSRM ${j.code}`)
    return j
  } finally {
    clearTimeout(timer)
  }
}

// Road geometry for the points in the order given (depot first). Returns
// { path: [[lat,lng],...], meters, seconds } or null when unusable — callers
// fall back to straight lines. `simplified` keeps the payload small (the line
// is visual; full resolution would push hundreds of KB into the mobile WebView).
export async function fetchRoadPath(points) {
  const pts = (points || []).filter(hasCoords)
  if (pts.length < 2) return null
  try {
    const j = await osrm(`/route/v1/driving/${coordString(pts)}?overview=simplified&geometries=geojson`)
    const route = j.routes && j.routes[0]
    if (!route || !route.geometry || !route.geometry.coordinates) return null
    return {
      path: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      meters: route.distance,
      seconds: route.duration,
    }
  } catch {
    return null
  }
}

// Driving matrix between every pair of points (seconds + meters). Used by the
// optimizer so ordering reflects real drive times, not straight-line distance.
// Returns { durations: number[][], distances: number[][] } or null.
export async function fetchDriveMatrix(points) {
  const pts = (points || []).filter(hasCoords)
  if (pts.length < 2) return null
  try {
    const j = await osrm(`/table/v1/driving/${coordString(pts)}?annotations=duration,distance`)
    if (!j.durations || !j.distances) return null
    // Snap failures come back as null cells — treat any null as "unusable" so
    // the caller cleanly falls back rather than optimizing on holes.
    for (const row of j.durations) if (row.some((v) => v == null)) return null
    return { durations: j.durations, distances: j.distances }
  } catch {
    return null
  }
}
