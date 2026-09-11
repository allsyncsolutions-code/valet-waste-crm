import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { STATUS_META } from '../lib/routeModel.js'
import { hasCoords } from '../lib/geo.js'

// Live route map. Renders the depot + numbered stop markers in sequence order
// and draws the route line — the real road geometry when `path` is provided
// (OSRM), straight lines between stops as the fallback. Pure Leaflet (free OSM
// tiles) so there's no per-mapload billing. Re-draws whenever the ordered stop
// list changes.
const SHARED_MARKER = { bg: '#f6d353', fg: '#5c4a12' } // yellow = address shared with another route today

export default function RouteMap({ depot, stops, path = null, height = 460, onStopClick }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)

  // Init map once.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const map = L.map(elRef.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
    })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map)
    map.setView([depot.lat, depot.lng], 12)
    mapRef.current = map
    layerRef.current = L.layerGroup().addTo(map)
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [depot.lat, depot.lng])

  // Redraw markers + polyline whenever the route changes.
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()

    // Depot marker (square).
    L.marker([depot.lat, depot.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:16px;height:16px;border-radius:4px;background:#15281d;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    })
      .bindTooltip(depot.name, { direction: 'top' })
      .addTo(layer)

    const pts = [[depot.lat, depot.lng]]
    // Only map stops with usable US coordinates. This skips un-geocoded stops
    // (null → "Invalid LatLng" crash) AND mis-geocoded ones (0,0 / abroad) that
    // would otherwise drag the map zoom out to the whole world.
    const located = stops.filter(hasCoords)
    located.forEach((s) => {
      const meta = STATUS_META[s.status] || STATUS_META.pending
      // Yellow while it still needs doing — the same address is on another
      // route today (alternate/backup run); done/skipped keep status colors.
      const shared = (s.sharedCodes || []).length > 0 && s.status === 'pending'
      const mk = shared ? SHARED_MARKER : meta
      pts.push([s.lat, s.lng])
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:26px;height:26px;border-radius:50%;background:${mk.bg};color:${mk.fg};border:${
            s.status === 'enroute' ? '2px solid #46c585' : '2px solid #fff'
          };display:flex;align-items:center;justify-content:center;font:600 12px 'IBM Plex Mono',monospace;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer">${s.seq}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      })
        .bindTooltip(`${s.seq}. ${s.name}${shared ? ` (⧉ also on Route ${(s.sharedCodes || []).join('/')})` : ''}`, { direction: 'top' })
        .on('click', () => { if (onStopClick) onStopClick(s) })
        .addTo(layer)
    })

    // Real road geometry when the caller fetched it (OSRM); straight shot between
    // stops otherwise. Same style either way so the fallback isn't jarring.
    const line = path && path.length > 1 ? path : pts
    L.polyline(line, {
      color: '#1f7a4d',
      weight: 3.5,
      opacity: 0.85,
      lineJoin: 'round',
    }).addTo(layer)

    if (pts.length > 1) {
      map.fitBounds(L.latLngBounds(pts).pad(0.18))
    } else {
      // No stops yet — center on the configured starting location.
      map.setView([depot.lat, depot.lng], 12)
    }
  }, [depot, stops, path])

  return <div ref={elRef} style={{ width: '100%', height, background: '#e9eee9' }} />
}
