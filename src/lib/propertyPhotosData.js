// Per-address (property) photos — used mainly to document addresses that were
// NOT checked in / skipped on a given day. Each photo carries a taken_on date
// (defaults to today, but the owner can override it). Images live in the public
// `property-photos` Storage bucket; the property_photos table tracks metadata.
//
// Sibling of photosData.js (which is keyed to route stops). This one is keyed
// to property_id so the photos live on the address file, regardless of route.
import { supabase } from './supabaseClient.js'

const BUCKET = 'property-photos'

const publicUrl = (path) => (path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null)

const shape = (r) => ({
  id: r.id,
  propertyId: r.property_id,
  path: r.path,
  url: r.path ? publicUrl(r.path) : (r.image_url || null),
  takenOn: r.taken_on,
  note: r.note || '',
  source: r.source || 'upload',
  createdAt: r.created_at,
})

// Load every photo for one property, newest taken_on first.
export async function loadPropertyPhotos(propertyId) {
  if (!propertyId) return []
  const { data, error } = await supabase
    .from('property_photos')
    .select('id, property_id, path, image_url, taken_on, note, source, created_at')
    .eq('property_id', propertyId)
    .order('taken_on', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map(shape)
}

// Upload one image file for a property with an optional date + note.
// takenOn is a 'YYYY-MM-DD' string; defaults to today server-side if omitted.
export async function uploadPropertyPhoto(propertyId, file, { takenOn, note } = {}) {
  const ext = (file.name && file.name.split('.').pop()) || 'jpg'
  const path = `${propertyId}/${crypto.randomUUID()}.${ext.toLowerCase()}`
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600', contentType: file.type || 'image/jpeg', upsert: false,
  })
  if (upErr) throw upErr
  const row = { property_id: propertyId, path, source: 'upload' }
  if (takenOn) row.taken_on = takenOn
  if (note) row.note = note
  const { data, error } = await supabase
    .from('property_photos')
    .insert(row)
    .select('id, property_id, path, image_url, taken_on, note, source, created_at')
    .single()
  if (error) throw error
  return shape(data)
}

// Update an existing photo's date and/or note (no new image).
export async function updatePropertyPhoto(id, { takenOn, note } = {}) {
  const patch = {}
  if (takenOn !== undefined) patch.taken_on = takenOn
  if (note !== undefined) patch.note = note
  if (!Object.keys(patch).length) return
  const { error } = await supabase.from('property_photos').update(patch).eq('id', id)
  if (error) throw error
}

export async function deletePropertyPhoto(photo) {
  const { error } = await supabase.from('property_photos').delete().eq('id', photo.id)
  if (error) throw error
  if (photo.path) {
    try { await supabase.storage.from(BUCKET).remove([photo.path]) } catch (e) { /* row gone; object cleanup best-effort */ }
  }
}
