// Bulk property import — shares the bulk_import_properties RPC with Randy, and
// the geocode-pending edge function for filling in coordinates afterward.
import { supabase } from './supabaseClient.js'

// Split one line into cells. Pipe/tab = simple split; comma = quote-aware CSV.
function splitCells(line, delim) {
  if (delim !== ',') return line.split(delim).map((s) => s.trim())
  const out = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false }
      else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

// Parse pasted text OR an uploaded CSV/TSV into property rows.
// Handles three shapes:
//   1. Pipe format:  CODE | Address, City Zip | Service | Notes  (address required)
//   2. CSV/TSV with a header row containing ADDRESS (+ optional CODE/CITY/ZIP/TYPE/LOCATION)
//   3. Plain addresses, one per line (the line starts with a street number)
// Titles and section-heading lines are skipped.
export function parseRows(text) {
  const str = String(text || '')
  const delim = str.includes('|') ? '|' : (str.includes('\t') ? '\t' : ',')
  const out = []
  let map = null // column index map, set when a header row is seen

  for (const raw of str.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cells = splitCells(line, delim)
    const lower = cells.map((c) => c.toLowerCase())

    // Header row? (defines the column mapping for CSV/TSV)
    if (lower.includes('address')) {
      const idx = (...names) => lower.findIndex((c) => names.includes(c))
      map = {
        code: idx('code'),
        address: idx('address'),
        city: idx('city'),
        zip: idx('zip', 'zipcode', 'zip code', 'postal'),
        service: idx('type', 'service'),
        notes: idx('location', 'notes', 'bin'),
      }
      continue
    }

    let rec
    if (map) {
      const get = (i) => (i >= 0 && i < cells.length ? cells[i] : '')
      const addr = [get(map.address), get(map.city)].filter(Boolean).join(', ')
      const zip = get(map.zip)
      rec = { code: get(map.code), name: '', address: zip ? `${addr} ${zip}` : addr, service: get(map.service), notes: get(map.notes) }
    } else if (delim === '|') {
      const [code = '', address = '', service = '', notes = ''] = cells
      rec = { code, name: '', address, service, notes }
    } else if (/^\d/.test(line)) {
      // Plain address line (starts with a street number).
      rec = { code: '', name: '', address: line, service: '', notes: '' }
    } else {
      // Comma/TSV data before any header (title, label rows) — skip.
      continue
    }

    if (!rec.address || !/\d/.test(rec.address)) continue // need a street number
    out.push(rec)
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
