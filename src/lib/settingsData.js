// App-wide settings (singleton row). Currently holds the depot / starting
// location used as the route map's home and the optimizer's start point.
import { supabase } from './supabaseClient.js'

export async function loadSettings() {
  const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  return data
}

// The depot in the shape the map/optimizer expect, or null if unset.
export function settingsDepot(settings) {
  if (settings && settings.depot_lat != null && settings.depot_lng != null) {
    return { name: settings.depot_name || 'Yard', lat: settings.depot_lat, lng: settings.depot_lng }
  }
  return null
}

export async function saveDepot({ name, address, lat, lng }) {
  const { error } = await supabase
    .from('app_settings')
    .update({
      depot_name: name || null,
      depot_address: address || null,
      depot_lat: lat,
      depot_lng: lng,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)
  if (error) throw error
}

// Free geocoding via OpenStreetMap Nominatim (no key). For light use only.
export async function geocodeAddress(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error('Geocoding service error')
  const d = await r.json()
  if (!d.length) throw new Error('No match for that address')
  return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon), display: d[0].display_name }
}

export function subscribeSettings(cb) {
  const ch = supabase
    .channel('settings-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, cb)
    .subscribe()
  return () => supabase.removeChannel(ch)
}
