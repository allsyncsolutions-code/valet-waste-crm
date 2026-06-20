// Geo helpers — pure functions, no dependencies.
// Distances are straight-line (haversine) scaled by a road-circuity factor to
// approximate real driving distance. When a real routing engine (Mapbox /
// OSRM / VROOM) is wired in, swap drivingMeters() for the engine's matrix and
// everything downstream keeps working.

const EARTH_M = 6371000

// Tuning knobs (clearly labelled estimates).
export const ROAD_CIRCUITY = 1.32 // streets aren't straight lines
export const AVG_SPEED_MPH = 22 // urban collection-route average
export const SERVICE_MIN_PER_STOP = 4 // time spent servicing each stop

export function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.sqrt(h))
}

// Estimated driving distance between two points, in meters.
export function drivingMeters(a, b) {
  return haversineMeters(a, b) * ROAD_CIRCUITY
}

export function metersToMiles(m) {
  return m / 1609.344
}

// Drive minutes for a given distance (excludes service time).
export function driveMinutes(meters) {
  const miles = metersToMiles(meters)
  return (miles / AVG_SPEED_MPH) * 60
}

export function formatMiles(meters) {
  return `${metersToMiles(meters).toFixed(1)} mi`
}

export function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h === 0) return `${rem}m`
  return `${h}h ${String(rem).padStart(2, '0')}m`
}
