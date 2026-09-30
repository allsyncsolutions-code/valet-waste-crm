// Duplicate detection for the Add-client form. As the office types a business
// name, contact, email, phone, or service address, score every existing client
// for "is this probably the same person?" — catching Rob/Robert, 123 Main St
// vs 123 Main Avenue, and phone/email matches across differently-named
// accounts (the StayLuxeNow/Robert case) BEFORE a second account is created.
//
// Pure functions, no supabase — the caller passes the already-loaded customer
// list and property index so realtime updates flow through for free.

// JS mirror of the DB's norm_address() (migration 0033) so a typed address
// compares against properties.norm_address on identical terms. The SQL
// function is the source of truth — update this map when it changes.
const PHRASES = [
  [/united states of america|united states|usa|us\b/g, ' '],
  [/new hampshire/g, 'nh'], [/new jersey/g, 'nj'], [/new mexico/g, 'nm'],
  [/new york/g, 'ny'], [/north carolina/g, 'nc'], [/north dakota/g, 'nd'],
  [/rhode island/g, 'ri'], [/south carolina/g, 'sc'], [/south dakota/g, 'sd'],
  [/west virginia/g, 'wv'],
]
const WORD_MAP = {
  street: 'st', saint: 'st', avenue: 'ave', drive: 'dr', road: 'rd',
  boulevard: 'blvd', lane: 'ln', court: 'ct', circle: 'cir', highway: 'hwy',
  place: 'pl', terrace: 'ter', parkway: 'pkwy',
  north: 'n', south: 's', east: 'e', west: 'w', apartment: 'apt',
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl',
  georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in',
  iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me',
  maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne',
  nevada: 'nv', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', tennessee: 'tn', texas: 'tx', utah: 'ut',
  vermont: 'vt', virginia: 'va', washington: 'wa', wisconsin: 'wi',
  wyoming: 'wy',
}
export function normAddress(a) {
  let t = String(a || '').toLowerCase()
  for (const [re, to] of PHRASES) t = t.replace(re, to)
  t = t.replace(/[.,#]/g, ' ')
  t = t.split(' ').map((w) => WORD_MAP[w] || w).filter(Boolean).join(' ')
  return t.replace(/\s+/g, ' ').trim()
}

// Street-type words (post-normalization abbreviations) and unit words, dropped
// when comparing address "cores" — that's what makes 123 Main St ≈ 123 Main Ave.
const CORE_DROP = new Set(['st', 'ave', 'dr', 'rd', 'blvd', 'ln', 'ct', 'cir', 'hwy', 'pl', 'ter', 'pkwy', 'apt', 'unit', 'ste', 'suite', 'n', 's', 'e', 'w'])

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
const normEmail = (s) => String(s || '').trim().toLowerCase()
const normPhone = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }

// "rob" matches "robert": every token of one side is a prefix of a token on
// the other, with a 3-char floor so 1-2 letter fragments match nobody.
function nameMatch(typed, existing) {
  const a = normName(typed), b = normName(existing)
  if (!a || !b) return null
  if (a === b || a.replace(/ /g, '') === b.replace(/ /g, '')) return 'exact'
  const at = a.split(' '), bt = b.split(' ')
  const fits = (small, big) => small.join(' ').length >= 3 && small.every((w) => w.length >= 3 && big.some((bw) => bw === w || bw.startsWith(w) || w.startsWith(bw)))
  return fits(at, bt) || fits(bt, at) ? 'partial' : null
}

// Exact: identical after normalization ("123 Main Street" == "123 Main St").
// Possible: same street number + street name with a different suffix/city
// tail ("123 Main St" vs "123 Main Ave") — the classic double-entry variant.
function addressMatch(typedNorm, existingNorm) {
  if (!typedNorm || !existingNorm) return null
  if (typedNorm === existingNorm) return 'exact'
  const tt = typedNorm.split(' '), et = existingNorm.split(' ')
  if (!/^\d+$/.test(tt[0] || '') || tt[0] !== et[0]) return null
  const core = (arr) => arr.slice(1).filter((w) => !CORE_DROP.has(w)).join(' ')
  const c1 = core(tt), c2 = core(et)
  return c1 && c1 === c2 ? 'possible' : null
}

// Weights per matched field (best tier per field counts once).
const WEIGHTS = {
  emailExact: 90, phoneExact: 85,
  nameExact: 80, namePartial: 55,
  addressExact: 80, addressPossible: 50,
}
export const DUP_SHOW_THRESHOLD = 50

// draft: the form state ({ name, contactName, email, phone, contactPhone, address })
// customers: rows as shaped by mapCustomer() in customersData.js
// propIndex: [{ customerId, address, normAddress }] — every service property
export function findClientDuplicates(draft, customers, propIndex) {
  const email = normEmail(draft.email)
  const phones = [normPhone(draft.phone), normPhone(draft.contactPhone)].filter(Boolean)
  const typedNames = [draft.name, draft.contactName].filter((s) => String(s || '').trim().length >= 3)
  const typedAddr = normAddress(draft.address)
  if (!email && !phones.length && !typedNames.length && !typedAddr) return []

  const propsByCustomer = {}
  for (const p of propIndex || []) {
    if (!propsByCustomer[p.customerId]) propsByCustomer[p.customerId] = []
    propsByCustomer[p.customerId].push(p)
  }

  const out = []
  for (const c of customers) {
    let score = 0
    let hitAddr = null // the property/record address that matched, for display
    const reasons = new Set()

    if (email && normEmail(c.email) === email) { score += WEIGHTS.emailExact; reasons.add('Email') }

    if (phones.length) {
      const existing = [normPhone(c.phone), normPhone(c.contactPhone)].filter(Boolean)
      if (phones.some((p) => existing.includes(p))) { score += WEIGHTS.phoneExact; reasons.add('Phone') }
    }

    if (typedNames.length) {
      const existingNames = [c.name, c.contactName].filter(Boolean)
      let tier = null
      for (const t of typedNames) for (const e of existingNames) {
        const m = nameMatch(t, e)
        if (m === 'exact') { tier = 'exact'; break }
        if (m === 'partial' && !tier) tier = 'partial'
      }
      if (tier) { score += tier === 'exact' ? WEIGHTS.nameExact : WEIGHTS.namePartial; reasons.add('Name') }
    }

    if (typedAddr) {
      let tier = null
      const candidates = [
        ...(propsByCustomer[c.id] || []).map((p) => ({ norm: p.normAddress || normAddress(p.address), raw: p.address })),
        { norm: normAddress(c.address), raw: c.address },
      ].filter((x) => x.norm)
      for (const cand of candidates) {
        const m = addressMatch(typedAddr, cand.norm)
        if (m === 'exact') { tier = 'exact'; hitAddr = cand.raw; break }
        if (m === 'possible' && !tier) { tier = 'possible'; hitAddr = cand.raw }
      }
      if (tier) { score += tier === 'exact' ? WEIGHTS.addressExact : WEIGHTS.addressPossible; reasons.add('Address') }
    }

    if (score >= DUP_SHOW_THRESHOLD) {
      const propRows = propsByCustomer[c.id] || []
      out.push({
        customerId: c.id,
        name: c.name || '(no name)',
        contactName: c.contactName || '',
        email: c.email || '',
        phone: c.phone || c.contactPhone || '',
        propCount: propRows.length,
        address: hitAddr || (propRows[0] && propRows[0].address) || c.address || '',
        reasons: [...reasons],
        score: Math.min(100, score),
      })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4)
}
