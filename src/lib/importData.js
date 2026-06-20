// Bulk property import — shares the bulk_import_properties RPC with Randy, and
// the geocode-pending edge function for filling in coordinates afterward.
import { supabase } from './supabaseClient.js'

// Parse pasted text into property rows.
// Preferred format, one per line:  CODE | Address, City Zip | Service | Notes
// (only the address is required). Lines with no "|" are treated as an address.
// Section headers like "Vilano Beach:" are skipped.
export function parseRows(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!line.includes('|')) {
      // skip obvious headings (no street number, or ends with a colon)
      if (line.endsWith(':') || !/\d/.test(line)) continue
      out.push({ code: '', name: '', address: line, service: '', notes: '' })
      continue
    }
    const p = line.split('|').map((s) => s.trim())
    const [code = '', address = '', service = '', notes = ''] = p
    if (!address) continue
    out.push({ code, name: '', address, service, notes })
  }
  return out
}

export async function loadClients() {
  const { data, error } = await supabase.from('customers').select('id, name').order('name')
  if (error) throw error
  return data || []
}

export async function bulkImport(payload) {
  const { data, error } = await supabase.rpc('bulk_import_properties', { payload })
  if (error) throw error
  return data // { customer_id, inserted }
}

export async function pendingGeocodeCount() {
  const { count, error } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .is('lat', null)
    .not('address', 'is', null)
  if (error) throw error
  return count || 0
}

// Loops geocode-pending until nothing remains (or a pass makes no progress).
export async function geocodeAll(onProgress) {
  let total = 0
  for (let i = 0; i < 60; i++) {
    const { data, error } = await supabase.functions.invoke('geocode-pending', { body: { limit: 15 } })
    if (error) throw error
    if (data && data.error) throw new Error(data.error)
    total += data.updated || 0
    if (onProgress) onProgress({ updated: total, remaining: data.remaining })
    if (!data.remaining || data.processed === 0) break
    if (data.updated === 0) break // no progress (un-geocodable rows) — stop
  }
  return total
}
