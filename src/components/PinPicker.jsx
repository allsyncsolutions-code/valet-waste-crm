import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { geocodeAddress } from '../lib/settingsData.js'

// Manual pin-drop for addresses the geocoders can't resolve (new construction,
// mis-typed streets, missing house numbers). Click the map (or drag the marker)
// to say exactly where this address is; Save writes the coordinates directly.
export default function PinPicker({ address, lat, lng, defaultCenter, onClose, onSave }) {
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const [point, setPoint] = useState(lat != null && lng != null ? { lat, lng } : null)
  const [query, setQuery] = useState('')
  const [searchErr, setSearchErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const center = lat != null && lng != null ? [lat, lng] : (defaultCenter || [29.9004, -81.3145]) // St. Augustine

  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const map = L.map(elRef.current, { zoomControl: true, scrollWheelZoom: false })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map)
    map.setView(center, lat != null ? 17 : 13)
    map.on('click', (e) => {
      setPoint({ lat: e.latlng.lat, lng: e.latlng.lng })
    })
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // Keep the marker in sync with the chosen point (click or programmatic).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !point) return
    if (!markerRef.current) {
      markerRef.current = L.marker([point.lat, point.lng], { draggable: true })
        .bindTooltip('Drag me onto the address', { direction: 'top' })
        .on('dragend', (e) => setPoint({ lat: e.target.getLatLng().lat, lng: e.target.getLatLng().lng }))
        .addTo(map)
    } else {
      markerRef.current.setLatLng([point.lat, point.lng])
    }
  }, [point])

  function runSearch(e) {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setSearchErr(null)
    geocodeAddress(q)
      .then((loc) => {
        mapRef.current && mapRef.current.setView([loc.lat, loc.lng], 17)
        if (!point) setPoint({ lat: loc.lat, lng: loc.lng })
      })
      .catch(() => setSearchErr('No match — try a nearby street or landmark instead.'))
      .finally(() => setBusy(false))
  }

  async function save() {
    if (!point || busy) return
    setBusy(true)
    try {
      await onSave(point)
      onClose()
    } catch (e) {
      setSearchErr(e.message || String(e))
      setBusy(false)
    }
  }

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,30,20,.45)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 14, width: 640, maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(15,30,20,.28)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid #eef0ed' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Set the map pin</div>
              <div style={{ fontSize: 12.5, color: '#7c8a82', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</div>
            </div>
            <div onClick={() => !busy && onClose()} style={{ cursor: 'pointer', color: '#7c8a82', fontSize: 18 }}>✕</div>
          </div>
          <div style={{ fontSize: 12, color: '#9aa69e', marginTop: 6 }}>Click the map where this address actually is (or search for a nearby street to jump there), then drag the pin to fine-tune.</div>
          <form onSubmit={runSearch} style={{ display: 'flex', gap: 8, marginTop: 9 }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Jump to a street or landmark…" style={{ flex: 1, border: '1px solid #dde2dd', background: '#f7f9f7', borderRadius: 9, padding: '8px 11px', fontSize: 13.5, outline: 'none' }} />
            <button type="submit" disabled={busy || !query.trim()} style={{ flex: 'none', background: '#fff', border: '1px solid #e6eae6', borderRadius: 9, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, color: '#5d6b63', cursor: 'pointer' }}>Find</button>
          </form>
          {searchErr && <div style={{ fontSize: 12, color: '#9a2c1e', marginTop: 6 }}>{searchErr}</div>}
        </div>
        <div ref={elRef} style={{ height: 400, flex: 'none', cursor: 'crosshair' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 18px', borderTop: '1px solid #eef0ed' }}>
          <div style={{ flex: 1, fontSize: 12, fontFamily: 'IBM Plex Mono', color: point ? '#1f7a4d' : '#9aa69e' }}>
            {point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : 'No point chosen yet — click the map'}
          </div>
          <button onClick={onClose} disabled={busy} style={{ background: '#fff', border: '1px solid #dde2dd', color: '#5d6b63', borderRadius: 9, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={busy || !point} style={{ background: '#1f7a4d', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: !point || busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save pin'}</button>
        </div>
      </div>
    </div>
  )
}
