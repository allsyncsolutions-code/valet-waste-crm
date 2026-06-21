// Pickup photos attached to route stops. Images live in the public
// `stop-photos` Storage bucket; the stop_photos table tracks metadata.
import { supabase } from './supabaseClient.js'

const BUCKET = 'stop-photos'

const publicUrl = (path) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl

// Load photos for a set of stops → { [stopId]: [{id, path, url, lat, lng, createdAt}] }.
export async function loadStopPhotos(stopIds) {
  const ids = (stopIds || []).filter(Boolean)
  if (!ids.length) return {}
  const { data, error } = await supabase
    .from('stop_photos')
    .select('id, stop_id, path, lat, lng, created_at')
    .in('stop_id', ids)
    .order('created_at', { ascending: true })
  if (error) throw error
  const map = {}
  for (const r of data || []) {
    ;(map[r.stop_id] ||= []).push({ id: r.id, path: r.path, url: publicUrl(r.path), lat: r.lat, lng: r.lng, createdAt: r.created_at })
  }
  return map
}

// Upload one image file for a stop, then record it. Returns the new photo.
export async function uploadStopPhoto(stopId, file, gps) {
  const ext = (file.name && file.name.split('.').pop()) || 'jpg'
  const path = `${stopId}/${crypto.randomUUID()}.${ext.toLowerCase()}`
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600', contentType: file.type || 'image/jpeg', upsert: false,
  })
  if (upErr) throw upErr
  const row = { stop_id: stopId, path }
  if (gps) { row.lat = gps.lat; row.lng = gps.lng }
  const { data, error } = await supabase.from('stop_photos').insert(row).select('id, path, lat, lng, created_at').single()
  if (error) throw error
  return { id: data.id, path: data.path, url: publicUrl(data.path), lat: data.lat, lng: data.lng, createdAt: data.created_at }
}

export async function deleteStopPhoto(photo) {
  const { error } = await supabase.from('stop_photos').delete().eq('id', photo.id)
  if (error) throw error
  try { await supabase.storage.from(BUCKET).remove([photo.path]) } catch (e) { /* row gone; object cleanup best-effort */ }
}

export function subscribeStopPhotos(cb) {
  const ch = supabase
    .channel('stop-photos-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'stop_photos' }, cb)
    .subscribe()
  return () => { try { supabase.removeChannel(ch) } catch (e) {} }
}
