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

const ZIP = /^\d{5}(-\d{4})?$/
const STREET = (c) => /^\d+\s*\S/.test(c) && !ZIP.test(c)
const SERVICE_RE = /(trash|recycl|compost|dumpster|garbage|pickup)/i

// Infer columns from a header-less tabular row (e.g. CODE, ADDRESS, City, Zip,
// TYPE, Location — with or without the leading CODE). Returns null if the row
// has no recognizable street address (so titles/section headings are skipped).
function inferRow(cells) {
  const c = cells.map((x) => (x || '').trim())
  const addrIdx = c.findIndex(STREET)
  if (addrIdx === -1) return null
  const zipIdx = c.findIndex((x) => ZIP.test(x))
  const serviceIdx = c.findIndex((x) => SERVICE_RE.test(x))
  const code = addrIdx >= 1 && /^[A-Za-z0-9]{1,6}$/.test(c[0]) ? c[0] : ''
  // City = first letters-only cell after the address (before the zip if present).
  const upper = zipIdx > addrIdx ? zipIdx : c.length
  let city = ''
  for (let i = addrIdx + 1; i < upper; i++) {
    if (i !== serviceIdx && /[A-Za-z]/.test(c[i]) && !/\d/.test(c[i])) { city = c[i]; break }
  }
  const zip = zipIdx >= 0 ? c[zipIdx] : ''
  const service = serviceIdx >= 0 ? c[serviceIdx] : ''
  // Notes = first lettered cell after the zip/service block (the Location column).
  let notes = ''
  for (let i = Math.max(addrIdx, zipIdx, serviceIdx) + 1; i < c.length; i++) {
    if (/[A-Za-z]/.test(c[i]) && c[i] !== city) { notes = c[i]; break }
  }
  const address = [c[addrIdx], city].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '')
  return { code, name: '', address, service, notes }
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
    } else if (cells.length >= 3 && cells.some((x) => ZIP.test(x)) && cells.some(STREET)) {
      // Header-less tabular row (CSV/TSV) — infer the columns.
      rec = inferRow(cells)
    } else if (/^\d/.test(line)) {
      // Plain address line (starts with a street number).
      rec = { code: '', name: '', address: line, service: '', notes: '' }
    } else {
      // Title / section-heading / junk line — skip.
      continue
    }
    if (!rec) continue

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
