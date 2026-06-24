// Route optimizer — a self-contained Traveling-Salesman heuristic.
//
// Strategy: nearest-neighbor to build an initial tour, then 2-opt to remove
// crossings. Open route (starts at the depot/yard, does NOT return). This is a
// free, dependency-free stand-in that gives near-optimal orders for the
// 8-25 stops a single truck runs. When you outgrow it, replace optimizeOrder()
// with a Mapbox Optimization v2 / VROOM call that returns the same shape:
//   { ordered, meters, minutes }
// and the dispatch + driver views need no changes.

import {
  drivingMeters,
  driveMinutes,
  hasCoords,
  SERVICE_MIN_PER_STOP,
} from './geo.js'

// Total estimated drive distance for depot -> stops (in given order), meters.
// Stops without usable coordinates (ungeocoded / mis-geocoded) are skipped so
// one bad pin can't inflate the total to tens of thousands of miles.
export function routeMeters(stops, depot) {
  const pts = stops.filter(hasCoords)
  if (!pts.length) return 0
  let total = 0
  let prev = (depot && hasCoords(depot)) ? depot : pts[0]
  const seq = (depot && hasCoords(depot)) ? pts : pts.slice(1)
  for (const s of seq) {
    total += drivingMeters(prev, s)
    prev = s
  }
  return total
}

// Distance + time (drive + service) for a route in its current order.
export function routeMetrics(stops, depot) {
  const meters = routeMeters(stops, depot)
  const minutes = driveMinutes(meters) + stops.length * SERVICE_MIN_PER_STOP
  return { meters, minutes }
}

function nearestNeighbor(stops, start) {
  const remaining = stops.slice()
  const order = []
  let cur = start
  while (remaining.length) {
    let bestIdx = 0
    let bestD = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = drivingMeters(cur, remaining[i])
      if (d < bestD) {
        bestD = d
        bestIdx = i
      }
    }
    cur = remaining.splice(bestIdx, 1)[0]
    order.push(cur)
  }
  return order
}

// 2-opt: repeatedly reverse segments that shorten the open tour from `start`.
function twoOpt(order, start) {
  const dist = (a, b) => drivingMeters(a, b)
  let improved = true
  let best = order.slice()
  while (improved) {
    improved = false
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const a = i === 0 ? start : best[i - 1]
        const b = best[i]
        const c = best[k]
        const d = k + 1 < best.length ? best[k + 1] : null
        // change in length if we reverse best[i..k]
        const before = dist(a, b) + (d ? dist(c, d) : 0)
        const after = dist(a, c) + (d ? dist(b, d) : 0)
        if (after + 1e-6 < before) {
          const seg = best.slice(i, k + 1).reverse()
          best = best.slice(0, i).concat(seg, best.slice(k + 1))
          improved = true
        }
      }
    }
  }
  return best
}

// Optimize the order of `stops` starting from `start` (depot or current truck
// location). Returns the reordered stops plus estimated distance/time.
export function optimizeOrder(stops, start) {
  // Only stops with usable coordinates can be sequenced by distance; keep any
  // ungeocoded stops and append them at the end so none are lost.
  const geo = stops.filter(hasCoords)
  const nogeo = stops.filter((s) => !hasCoords(s))
  if (geo.length <= 2) {
    return { ordered: [...geo, ...nogeo], ...routeMetrics(stops, start) }
  }
  const nn = nearestNeighbor(geo, start)
  const optimized = twoOpt(nn, start)
  const ordered = [...optimized, ...nogeo]
  return { ordered, ...routeMetrics(ordered, start) }
}
