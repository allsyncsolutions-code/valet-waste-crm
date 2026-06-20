import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { STATUS_META } from '../lib/routeModel.js'

// Live route map. Renders the depot + numbered stop markers in sequence order
// and draws the route polyline. Pure Leaflet (free OSM tiles) so there's no
// per-mapload billing. Re-draws whenever the ordered stop list changes.
export default function RouteMap({ depot, stops, height = 460 }) {
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
    stops.forEach((s) => {
      const meta = STATUS_META[s.status] || STATUS_META.pending
      pts.push([s.lat, s.lng])
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:26px;height:26px;border-radius:50%;background:${meta.bg};color:${meta.fg};border:${
            s.status === 'enroute' ? '2px solid #46c585' : '2px solid #fff'
          };display:flex;align-items:center;justify-content:center;font:600 12px 'IBM Plex Mono',monospace;box-shadow:0 1px 4px rgba(0,0,0,.3)">${s.seq}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      })
        .bindTooltip(`${s.seq}. ${s.name}`, { direction: 'top' })
        .addTo(layer)
    })

    L.polyline(pts, {
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
  }, [depot, stops])

  return <div ref={elRef} style={{ width: '100%', height, background: '#e9eee9' }} />
}
