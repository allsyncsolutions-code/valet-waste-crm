// Shared CSV parsing/validation for bulk service-address uploads — used by the
// public bulk signup (portal/BulkSignupPage.jsx, ?signup=bulk) AND the staff
// Import view (views/Import.jsx), so a property manager's filled-in template
// parses identically whether the PM uploads it themselves or emails it to the
// office. Single source of truth for the template columns, the schedule
// vocabulary, and per-row validation; the portal edge function re-validates
// server-side before anything is created.
import { normAddress } from './duplicateCheck.js'

export const MAX_ROWS = 500
export const MAX_BYTES = 1024 * 1024 // 1 MB — far more than 500 rows ever needs

// ---------------------------------------------------------------------------
// CSV parsing — no dependency: handles BOM, \r\n, quoted fields, escaped "".
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '')
  const rows = []
  let row = [], cur = '', inQ = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cur); cur = ''
      rows.push(row); row = []
    } else cur += ch
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row) }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''))
}

// Header synonyms → canonical keys. Extra columns are ignored so PMs can keep
// their own spreadsheet columns alongside the required ones.
export const HEADER_ALIASES = {
  street: 'street', address: 'street', service_address: 'street',
  unit: 'unit', unit_number: 'unit', apt: 'unit',
  city: 'city', state: 'state',
  zip: 'zip', zipcode: 'zip', postal_code: 'zip', postal_code_zip: 'zip',
  schedule: 'schedule', frequency: 'schedule', pickups: 'schedule',
  start_date: 'startDate', start: 'startDate',
  notes: 'notes', note: 'notes',
  resident_name: 'residentName', resident: 'residentName',
  resident_phone: 'residentPhone',
}
export const SCHED_LABEL = { '1x': '1 pickup / week', '2x': '2 pickups / week', on_demand: 'On-Demand' }

export function normalizeSchedule(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['', '1', '1x', 'one', 'weekly', '1_pickup'].includes(s)) return { ok: true, value: '1x' }
  if (['2', '2x', 'two', '2_pickups'].includes(s)) return { ok: true, value: '2x' }
  if (['on_demand', 'ondemand', 'demand', 'on_call', 'one_time'].includes(s)) return { ok: true, value: 'on_demand' }
  return { ok: false, value: '1x' }
}

// YYYY-MM-DD or M/D/YYYY (what Excel leaves in the cell) → ISO, else invalid.
export function normalizeDate(v) {
  const s = String(v ?? '').trim()
  if (!s) return { ok: true, value: '' }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return { ok: true, value: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)) && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return { ok: true, value: `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` }
  return { ok: false, value: '' }
}

// Full state names → 2-letter code via normAddress's WORD_MAP ("new york"→"ny",
// "florida"→"fl"); already-abbreviated values pass through unchanged.
export function normalizeState(v) {
  const t = normAddress(String(v ?? '')).replace(/\s+/g, ' ')
  return /^[a-z]{2}$/.test(t) ? t.toUpperCase() : ''
}

export function displayAddr(r) {
  return `${r.street}${r.unit ? ` Unit ${r.unit}` : ''}, ${r.city}, ${r.state} ${r.zip}`
}

// matrix (array of string arrays) → { rows, headerError }. Each row carries a
// problems[] list; empty = ready to submit. headerError set when the header
// row doesn't have the required columns (caller shows it / falls back).
export function buildRows(matrix) {
  if (!matrix.length) return { rows: [], headerError: 'That file looks empty.' }
  const header = matrix[0].map((h) => String(h).trim().toLowerCase())
  const colOf = {}
  header.forEach((h, idx) => { const k = HEADER_ALIASES[h]; if (k && colOf[k] == null) colOf[k] = idx })
  const missing = ['street', 'city', 'state', 'zip'].filter((k) => colOf[k] == null)
  if (missing.length) {
    return { rows: [], headerError: `This doesn't look like the template — missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` }
  }
  const cell = (r, k) => (colOf[k] != null && r[colOf[k]] != null ? String(r[colOf[k]]).trim() : '')

  const rows = matrix.slice(1).map((r, i) => {
    const row = {
      i,
      street: cell(r, 'street'), unit: cell(r, 'unit'), city: cell(r, 'city'),
      state: normalizeState(cell(r, 'state')), zip: cell(r, 'zip'),
      schedule: '1x', startDate: '', notes: cell(r, 'notes'),
      residentName: cell(r, 'residentName'), residentPhone: cell(r, 'residentPhone'),
      problems: [],
    }
    if (!row.street || !row.city) row.problems.push('missing street or city')
    if (!row.state) row.problems.push(`state "${cell(r, 'state')}" — use the 2-letter code (e.g. FL)`)
    if (!/^\d{5}(-\d{4})?$/.test(row.zip)) row.problems.push(`zip "${row.zip}" — use 5 digits (e.g. 32080)`)
    const sched = normalizeSchedule(cell(r, 'schedule'))
    if (!sched.ok) row.problems.push(`schedule "${cell(r, 'schedule')}" — use 1x, 2x, or on_demand`)
    row.schedule = sched.value
    const dt = normalizeDate(cell(r, 'startDate'))
    if (!dt.ok) row.problems.push(`start date "${cell(r, 'startDate')}" — use YYYY-MM-DD`)
    row.startDate = dt.value
    if (row.residentPhone && row.residentPhone.replace(/\D/g, '').length < 10) row.problems.push('resident phone needs at least 10 digits')
    row.addr = displayAddr(row)
    return row
  })

  // In-file duplicates: same normalized address twice in the file.
  const seen = new Map()
  for (const row of rows) {
    if (row.problems.length) continue
    const key = normAddress(row.addr)
    const first = seen.get(key)
    if (first != null) row.problems.push(`duplicate of row ${first + 2} in your file`)
    else seen.set(key, row.i)
  }
  return { rows, headerError: '' }
}

// True when the text looks like the PM bulk template (vs. the legacy pipe /
// plain-address formats the Import view also accepts). Requires state as well
// as a street-ish + zip column so legacy headers like "code,address,city,zip"
// still fall through to the legacy parser.
export function looksLikeTemplate(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0].toLowerCase()
  return ['street', 'address', 'service_address'].some((h) => first.includes(h))
    && first.includes('state')
    && first.includes('zip')
}

// Combine a template row's optional fields into one notes string for the staff
// import (the RPC takes batch-level schedule; per-row schedule/start/resident
// details ride along in the property notes so nothing the PM typed is lost).
export function templateRowNotes(r) {
  return [
    r.schedule !== '1x' ? `Schedule: ${SCHED_LABEL[r.schedule]}` : '',
    r.startDate ? `Start: ${r.startDate}` : '',
    r.residentName ? `Resident: ${r.residentName}${r.residentPhone ? ` (${r.residentPhone})` : ''}` : '',
    r.notes || '',
  ].filter(Boolean).join(' · ')
}
