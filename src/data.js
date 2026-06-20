// All mock data + helper logic ported from the Claude Design handoff bundle.

export const MONO = "'IBM Plex Mono', monospace"

export const LINES = [
  { id: 'waste', name: 'Waste & Recycling', meta: '', color: '#1f7a4d' },
  { id: 'junk', name: 'Junk Removal', meta: '', color: '#2f6db0' },
  { id: 'lawn', name: 'Lawn Care', meta: '', color: '#7a9e2e' },
]

export const KPIS = [
  { label: 'Stops today', value: '38', dot: '#1f7a4d', delta: '21 done · 15 left', deltaColor: '#7c8a82' },
  { label: 'On route', value: '3', dot: '#2f6db0', delta: 'Trucks 14 · 7 · 22', deltaColor: '#7c8a82' },
  { label: 'Behind', value: '1', dot: '#c08a2e', delta: 'Truck 7 · +22 min', deltaColor: '#b07a1e' },
  { label: 'Overdue', value: '2', dot: '#c0492f', delta: 'Reschedule needed', deltaColor: '#c0492f' },
  { label: 'Revenue MTD', value: '$84.2k', dot: '#15281d', delta: '▲ 8.4% vs May', deltaColor: '#1f7a4d' },
]

export const DASH_ROUTES = [
  { code: 'A', name: 'North Loop', driver: 'Marcus T.', truck: 'Truck 14', tint: '#e7f1eb', color: '#1f7a4d', statusLabel: 'ON TIME', statusColor: '#1f7a4d', etaText: 'ETA 11:40', pct: '64%', progress: '9/14' },
  { code: 'B', name: 'Riverside & Maple', driver: 'Dana R.', truck: 'Truck 7', tint: '#fdf2e0', color: '#c08a2e', statusLabel: '+22 MIN', statusColor: '#b07a1e', etaText: 'ETA 12:55', pct: '42%', progress: '5/12' },
  { code: 'C', name: 'Industrial East', driver: 'Luis G.', truck: 'Truck 22', tint: '#e9eef6', color: '#2f6db0', statusLabel: 'ON TIME', statusColor: '#2f6db0', etaText: 'ETA 1:15', pct: '58%', progress: '7/12' },
]

export const ALERTS = [
  { color: '#c0492f', title: 'Oakwood HOA — missed pickup', meta: 'Truck 7 skipped · client notified · reschedule' },
  { color: '#c08a2e', title: 'Cedar Industrial — extra pickup requested', meta: 'Via portal · 9:02 AM · unrouted' },
  { color: '#2f6db0', title: 'Sunrise Medical — gate code changed', meta: 'Driver note added to stop #8' },
]

export const ROUTE_TABS_RAW = [
  { code: 'A', name: 'North Loop', driver: 'Marcus T.', active: false },
  { code: 'B', name: 'Riverside & Maple', driver: 'Dana R.', active: true },
  { code: 'C', name: 'Industrial East', driver: 'Luis G.', active: false },
]

export const STOPS_RAW = [
  { num: '1', client: 'Lakeside Café', detail: '2× 96gal toter · recycling', statusLabel: 'DONE', statusColor: '#1f7a4d', window: '7:05a', showProof: true, isCurrent: false, checkIn: '7:04a', checkOut: '7:11a', gps: '44.81,-93.16' },
  { num: '2', client: 'Maple Grove Apartments', detail: '4yd dumpster ×2', statusLabel: 'DONE', statusColor: '#1f7a4d', window: '7:30a', showProof: true, isCurrent: false, checkIn: '7:33a', checkOut: '7:48a', gps: '44.82,-93.18' },
  { num: '3', client: 'Riverside Diner', detail: '2yd dumpster · grease pen', statusLabel: 'DONE', statusColor: '#1f7a4d', window: '8:10a', showProof: true, isCurrent: false, checkIn: '8:12a', checkOut: '8:20a', gps: '44.83,-93.19' },
  { num: '4', client: 'Birchwood Townhomes', detail: '6yd dumpster', statusLabel: 'DONE', statusColor: '#1f7a4d', window: '8:45a', showProof: true, isCurrent: false, checkIn: '8:51a', checkOut: '9:02a', gps: '44.84,-93.20' },
  { num: '5', client: 'Sunrise Medical Center', detail: '8yd · gate code 4417', statusLabel: 'ON SITE', statusColor: '#c08a2e', window: '9:30a', showProof: false, isCurrent: true, checkIn: '', checkOut: '', gps: '' },
  { num: '6', client: 'Oakwood HOA — Clubhouse', detail: '4yd dumpster', statusLabel: 'NEXT', statusColor: '#5d6b63', window: '10:10a', showProof: false, isCurrent: false, checkIn: '', checkOut: '', gps: '' },
  { num: '7', client: 'Pinecrest School', detail: '2× 6yd dumpster', statusLabel: 'UPCOMING', statusColor: '#9aa69e', window: '10:45a', showProof: false, isCurrent: false, checkIn: '', checkOut: '', gps: '' },
  { num: '+', client: 'Cedar Industrial (new)', detail: 'Extra pickup · 20yd roll-off', statusLabel: 'UNROUTED', statusColor: '#b07a1e', window: 'req 9:02a', showProof: false, isCurrent: false, checkIn: '', checkOut: '', gps: '' },
]

export function decorateStops() {
  return STOPS_RAW.map((st) => ({
    ...st,
    numBg: st.statusLabel === 'DONE' ? '#1f7a4d' : st.isCurrent ? '#173d2a' : st.num === '+' ? '#c08a2e' : '#eef0ed',
    numFg: st.statusLabel === 'DONE' || st.isCurrent || st.num === '+' ? '#fff' : '#5d6b63',
    numBorder: st.isCurrent ? '2px solid #46c585' : 'none',
  }))
}

export function clientData() {
  return [
    { id: 'sp', initials: 'SP', tint: '#e7f1eb', color: '#1f7a4d', name: 'Summit Property Group', cadence: '104 properties · mixed', mrr: '$11,240', address: 'Property management · 104 active sites', ltv: '$214,800', pm: true, propCount: 104 },
    { id: 'ng', initials: 'NL', tint: '#e7f1eb', color: '#1f7a4d', name: 'Northgate Retail Park', cadence: '1st & 3rd Monday', mrr: '$432', address: '2100 Northgate Blvd, Suite 4', ltv: '$18,420' },
    { id: 'mg', initials: 'MG', tint: '#e9eef6', color: '#2f6db0', name: 'Maple Grove Apartments', cadence: 'Weekly · Tuesday', mrr: '$720', address: '88 Maple Grove Dr', ltv: '$31,960' },
    { id: 'rd', initials: 'RD', tint: '#fdf2e0', color: '#c08a2e', name: 'Riverside Diner', cadence: 'Tue & Fri', mrr: '$400', address: '14 River St', ltv: '$9,240' },
    { id: 'ci', initials: 'CI', tint: '#f1ece4', color: '#7a6a52', name: 'Cedar Industrial', cadence: 'Weekly · Monday', mrr: '$1,620', address: '900 Industrial Pkwy', ltv: '$48,120' },
    { id: 'ok', initials: 'OH', tint: '#e7f1eb', color: '#1f7a4d', name: 'Oakwood HOA', cadence: '2nd & 4th Wednesday', mrr: '$280', address: 'Oakwood Community Assoc.', ltv: '$12,040' },
    { id: 'sm', initials: 'SM', tint: '#e9eef6', color: '#2f6db0', name: 'Sunrise Medical Center', cadence: 'Mon & Thu', mrr: '$960', address: '1840 Cedar Pkwy', ltv: '$22,800' },
  ]
}

export const ROUTE_NAMES = { A: 'North Loop', B: 'Riverside & Maple', C: 'Industrial East' }

export function generateProperties(n) {
  const streets = ['Maple', 'Riverside', 'Oakwood', 'Cedar', 'Birch', 'Sunset', 'Lakeview', 'Pinecrest', 'Highland', 'Willow', 'Brookside', 'Ashford', 'Glenwood', 'Fairview', 'Summit', 'Meadow', 'Aspen', 'Stonegate', 'Harbor', 'Crestline']
  const types = ['Apartments', 'Townhomes', 'Plaza', 'Commons', 'Office Park', 'Retail Center', 'Estates', 'Lofts', 'Square', 'Court']
  const cadences = ['Weekly · Mon', '1st & 3rd Mon', '2nd & 4th Wed', 'Tue & Fri', 'Weekly · Thu', 'Weekly · Wed', '1st & 3rd Fri']
  const services = ['4yd dumpster ×2', '6yd dumpster', '2× 96gal toter', '8yd dumpster', '20yd roll-off', '4yd dumpster']
  const routeCodes = ['A', 'B', 'C']
  const rates = [48, 62, 38, 95, 240, 48]
  const out = []
  for (let i = 0; i < n; i++) {
    const st = streets[i % streets.length]
    const ty = types[(i * 3) % types.length]
    const paused = i % 17 === 5
    const rc = routeCodes[i % 3]
    out.push({
      id: 'p' + i, idx: i,
      name: st + ' ' + ty,
      addr: 100 + i * 7 + ' ' + st + ' ' + (i % 2 ? 'Ave' : 'St') + ', Unit ' + ((i % 40) + 1),
      cadence: cadences[i % cadences.length],
      service: services[i % services.length],
      route: rc, routeName: ROUTE_NAMES[rc],
      plan: i % 4 === 0 ? 'stop' : 'monthly',
      rate: rates[i % rates.length],
      notes: i % 5 === 0 ? 'Gate code ' + (4000 + i) + '. Bins behind building, alley access.' : '',
      status: paused ? 'Paused' : 'Active',
      statusColor: paused ? '#9aa69e' : '#1f7a4d',
      statusBg: paused ? '#eef0ed' : '#e7f1eb',
      initials: (st[0] + ty[0]).toUpperCase(),
    })
  }
  return out
}

export const CLIENT_STOPS = [
  { date: 'Jun 15', service: '4yd dumpster ×4', in: '7:08a', out: '7:21a', driver: 'Marcus T.' },
  { date: 'Jun 11', service: '4yd dumpster ×4', in: '7:14a', out: '7:26a', driver: 'Marcus T.' },
  { date: 'Jun 8', service: '4yd dumpster ×4', in: '7:02a', out: '7:15a', driver: 'Marcus T.' },
  { date: 'Jun 4', service: '4yd dumpster ×4', in: '7:19a', out: '7:30a', driver: 'Dana R.' },
]

export const DRIVERS = [
  { initials: 'MT', name: 'Marcus T.', truck: 'Truck 14', status: 'On route · Route A · stop 9/14', dot: '#22b06b', done: '9' },
  { initials: 'DR', name: 'Dana R.', truck: 'Truck 7', status: 'On site · Sunrise Medical · +22 min', dot: '#c08a2e', done: '5' },
  { initials: 'LG', name: 'Luis G.', truck: 'Truck 22', status: 'On route · Route C · stop 7/12', dot: '#22b06b', done: '7' },
]

export const FIELD_FEED = [
  { dot: '#1f7a4d', who: 'Dana R.', action: 'checked in at', where: 'Sunrise Medical', time: '9:38a', gps: '44.84,-93.20', photo: false },
  { dot: '#1f7a4d', who: 'Marcus T.', action: 'completed', where: 'Birchwood Townhomes', time: '9:02a', gps: '44.84,-93.20', photo: true },
  { dot: '#c0492f', who: 'Dana R.', action: 'reported overflow at', where: 'Maple Grove', time: '7:48a', gps: '44.82,-93.18', photo: true },
  { dot: '#1f7a4d', who: 'Luis G.', action: 'completed', where: 'Cedar Industrial', time: '7:31a', gps: '44.79,-93.14', photo: true },
]

export const PORTAL_FEATURES = [
  { glyph: '◷', title: 'Upcoming pickups & schedule', desc: 'See the recurring cadence and next service dates' },
  { glyph: '▦', title: 'GPS-verified photos', desc: 'Proof-of-service photos for every completed stop' },
  { glyph: '$', title: 'Invoices & online payment', desc: 'View monthly statements and pay in one tap' },
  { glyph: '+', title: 'Request an extra pickup', desc: 'Requests drop straight into your dispatch queue' },
  { glyph: '✦', title: 'Check-in history', desc: 'Timestamped arrival / departure for every visit' },
]

export function teamData() {
  return [
    { id: 't1', name: 'Rosa Herrera', role: 'Dispatch Lead', contact: 'rosa@valetwaste.co', avatar: '#3a5246', status: 'Active', lines: ['waste', 'junk', 'lawn'] },
    { id: 't2', name: 'Marcus Thompson', role: 'Driver · Truck 14', contact: '(612) 555-0142', avatar: '#2f4a3d', status: 'On route', lines: ['waste'] },
    { id: 't3', name: 'Dana Reyes', role: 'Driver · Truck 7', contact: '(612) 555-0177', avatar: '#2f4a3d', status: 'On site', lines: ['waste'] },
    { id: 't4', name: 'Luis Garcia', role: 'Driver · Truck 22', contact: '(612) 555-0122', avatar: '#2f4a3d', status: 'On route', lines: ['waste', 'junk'] },
    { id: 't5', name: 'Priya Shah', role: 'Billing & AR', contact: 'priya@valetwaste.co', avatar: '#4a3f5a', status: 'Active', lines: ['waste', 'junk', 'lawn'] },
    { id: 't6', name: 'Tom Becker', role: 'Junk Removal Crew', contact: '(612) 555-0190', avatar: '#3a4a5a', status: 'Active', lines: ['junk'] },
    { id: 't7', name: 'Aisha Khan', role: 'Lawn Care Lead', contact: 'aisha@valetwaste.co', avatar: '#4a5a3a', status: 'Active', lines: ['lawn'] },
    { id: 't8', name: 'Carlos Mendez', role: 'Lawn Crew', contact: '(612) 555-0166', avatar: '#4a5a3a', status: 'Off today', lines: ['lawn'] },
    { id: 't9', name: 'Jenna Wolfe', role: 'Customer Success', contact: 'jenna@valetwaste.co', avatar: '#5a4a3a', status: 'Active', lines: ['waste', 'junk', 'lawn'] },
  ]
}

export const TEAM_LINE_DEFS = [
  { id: 'waste', label: 'Waste', color: '#1f7a4d', bg: '#e7f1eb', border: '#cfe0d5' },
  { id: 'junk', label: 'Junk', color: '#2f6db0', bg: '#e9eef6', border: '#cdddee' },
  { id: 'lawn', label: 'Lawn', color: '#5f7d1f', bg: '#eef3df', border: '#dde7c2' },
]

export function invoiceData() {
  return [
    { id: 'ng', initials: 'NL', client: 'Northgate Retail Park', number: 'INV-2026-0612', period: 'June 2026', stops: 9, amount: '$462.42', subtotal: '$432.00', tax: '$30.24', status: 'DRAFT', statusColor: '#7c8a82', statusBg: '#eef0ed',
      items: [['Jun 1', '4yd dumpster ×4', 'North Loop'], ['Jun 4', '4yd dumpster ×4', 'North Loop'], ['Jun 8', '4yd dumpster ×4', 'North Loop'], ['Jun 11', '4yd dumpster ×4', 'North Loop'], ['Jun 15', '4yd dumpster ×4', 'North Loop'], ['Jun 18', '4yd dumpster ×4', 'North Loop'], ['Jun 22', 'Extra haul', 'Overflow'], ['Jun 25', '4yd dumpster ×4', 'North Loop'], ['Jun 29', '4yd dumpster ×4', 'North Loop']] },
    { id: 'mg', initials: 'MG', client: 'Maple Grove Apartments', number: 'INV-2026-0609', period: 'June 2026', stops: 6, amount: '$770.00', subtotal: '$719.63', tax: '$50.37', status: 'SENT', statusColor: '#2f6db0', statusBg: '#e9eef6',
      items: [['Jun 2', '4yd dumpster ×2', 'Route B'], ['Jun 9', '4yd dumpster ×2', 'Route B'], ['Jun 16', '4yd dumpster ×2', 'Route B'], ['Jun 23', '4yd dumpster ×2', 'Route B'], ['Jun 30', '4yd dumpster ×2', 'Route B'], ['Jun 12', 'Bulk pickup', 'On-demand']] },
    { id: 'rd', initials: 'RD', client: 'Riverside Diner', number: 'INV-2026-0604', period: 'June 2026', stops: 8, amount: '$427.84', subtotal: '$399.85', tax: '$27.99', status: 'OVERDUE', statusColor: '#c0492f', statusBg: '#f6e7e4',
      items: [['Jun 2', '2yd + grease', 'Route B'], ['Jun 5', '2yd + grease', 'Route B'], ['Jun 9', '2yd + grease', 'Route B'], ['Jun 12', '2yd + grease', 'Route B'], ['Jun 16', '2yd + grease', 'Route B'], ['Jun 19', '2yd + grease', 'Route B'], ['Jun 23', '2yd + grease', 'Route B'], ['Jun 26', '2yd + grease', 'Route B']] },
    { id: 'ci', initials: 'CI', client: 'Cedar Industrial', number: 'INV-2026-0617', period: 'June 2026', stops: 5, amount: '$1,733.60', subtotal: '$1,620.00', tax: '$113.60', status: 'DRAFT', statusColor: '#7c8a82', statusBg: '#eef0ed',
      items: [['Jun 1', '20yd roll-off', 'Industrial E'], ['Jun 8', '20yd roll-off', 'Industrial E'], ['Jun 15', '20yd roll-off', 'Industrial E'], ['Jun 18', '20yd roll-off (extra)', 'On-demand'], ['Jun 22', '20yd roll-off', 'Industrial E']] },
    { id: 'ph', initials: 'PS', client: 'Pinecrest School', number: 'INV-2026-0521', period: 'May 2026', stops: 10, amount: '$642.00', subtotal: '$600.00', tax: '$42.00', status: 'PAID', statusColor: '#1f7a4d', statusBg: '#e7f1eb',
      items: [['May 1', '6yd dumpster ×2', 'North Loop'], ['May 5', '6yd dumpster ×2', 'North Loop']] },
  ]
}

// ---------- recurrence logic ----------
export function defaultSched() {
  return { mode: 'nth', days: { 1: true }, nths: { 1: true, 3: true }, interval: 2 }
}

export function schedMatches(date, sc) {
  const dow = date.getDay()
  if (!sc.days[dow]) return false
  if (sc.mode === 'weekly') return true
  if (sc.mode === 'nth') {
    const nth = Math.ceil(date.getDate() / 7)
    const dim = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    const isLast = date.getDate() + 7 > dim
    return !!sc.nths[nth] || (!!sc.nths.last && isLast)
  }
  if (sc.mode === 'interval') {
    const epoch = Date.UTC(2026, 0, 5)
    const d = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    const wk = Math.floor((d - epoch) / (7 * 86400000))
    return (((wk % sc.interval) + sc.interval) % sc.interval) === 0
  }
  return false
}

// ---------- AI fallback ----------
export function fallbackReply(text) {
  const t = (text || '').toLowerCase()
  if (/optim|route|sequenc|re-?order/.test(t))
    return { text: "Looking at today's Route B: re-sequencing by drive time saves an estimated 14 min and 6.2 mi. I'd move Riverside Diner ahead of Maple Grove and batch the two Oakwood stops. Shall I apply it and notify Dana?", action: 'Apply optimized sequence to Route B & notify driver' }
  if (/invoic|bill|charge|payment/.test(t))
    return { text: "I can bill this per stop and roll it into the client's end-of-month statement. Northgate Retail Park currently has 9 unbilled stops this cycle at $48 each = $432. Want me to add this pickup as a line item on their June batch invoice?", action: 'Add pickup to Northgate June batch invoice ($48)' }
  if (/schedul|recur|every|monday|biweek|cadence/.test(t))
    return { text: "Got it — I'll set this stop to recur on the 1st & 3rd Monday, matching the rest of the North loop. Next two pickups would land June 16 and July 7. Confirm the cadence?", action: 'Create recurring schedule: 1st & 3rd Monday' }
  if (/message|team|driver|notify|tell/.test(t))
    return { text: "I'll send this to the field team. Marcus (Truck 14) and Dana (Truck 7) are both active right now. Want it as a route note or a direct message?", action: 'Message field team: Marcus & Dana' }
  return { text: "On it. I can route new pickups, build recurring schedules, set up per-stop or monthly billing, optimize live routes, and message the field team. What would you like me to do?", action: '' }
}
