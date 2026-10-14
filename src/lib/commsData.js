// Communications data: unified receipts for texts (sms_messages) and emails
// (email_messages, mig 0066). Texts have been logged since the beginning;
// emails accumulate receipts from the 2026-10-14 edge-function deploy on.
// Both merge into one timeline for the Communications tab.
import { supabase } from './supabaseClient.js'

const PAGE = 150

async function loadSms({ direction, status, q, customerId, limit }) {
  let query = supabase
    .from('sms_messages')
    .select('id, created_at, direction, provider, to_number, from_number, body, status, error, customer_id, external_id, purpose, sent_by')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (direction && direction !== 'all') query = query.eq('direction', direction)
  if (status && status !== 'all') query = query.eq('status', status)
  if (customerId) query = query.eq('customer_id', customerId)
  if (q) query = query.or(`body.ilike.%${q}%,to_number.ilike.%${q}%,from_number.ilike.%${q}%`)
  const { data, error } = await query
  if (error) throw error
  return (data || []).map((r) => ({ ...r, channel: 'sms' }))
}

async function loadEmail({ status, q, customerId, limit }) {
  let query = supabase
    .from('email_messages')
    .select('id, created_at, direction, provider, to_email, from_email, subject, body_text, body_html, status, error, purpose, customer_id, sent_by, related_type, related_id')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (status && status !== 'all') query = query.eq('status', status)
  if (customerId) query = query.eq('customer_id', customerId)
  if (q) query = query.or(`subject.ilike.%${q}%,body_text.ilike.%${q}%,to_email.ilike.%${q}%`)
  const { data, error } = await query
  if (error) throw error
  return (data || []).map((r) => ({ ...r, channel: 'email' }))
}

// Resolve display names: by customer_id first, then by matching the
// recipient address/number against the customers table.
export async function loadComms({ channel = 'all', direction = 'all', status = 'all', q = '', customerId = null, limit = PAGE } = {}) {
  const [sms, emails] = await Promise.all([
    channel === 'email' ? [] : loadSms({ direction, status, q, customerId, limit }),
    channel === 'sms' ? [] : loadEmail({ status, q, customerId, limit }),
  ])
  const rows = [...sms, ...emails].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit)

  const custIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))]
  const emails_ = [...new Set(rows.filter((r) => r.channel === 'email').map((r) => r.to_email))]
  const phones = [...new Set(rows.filter((r) => r.channel === 'sms').flatMap((r) => [r.to_number, r.from_number]).filter(Boolean))]
  let byId = {}, byEmail = {}, byPhone = {}
  if (custIds.length) {
    const { data } = await supabase.from('customers').select('id, name, email, phone, contact_phone').in('id', custIds)
    for (const c of data || {}) byId[c.id] = c.name
  }
  if (emails_.length) {
    const { data } = await supabase.from('customers').select('name, email').in('email', emails_)
    for (const c of data || {}) if (c.email) byEmail[c.email.toLowerCase()] = c.name
  }
  const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10)
  if (phones.length) {
    // Phone match client-side (last-10 digits) — PostgREST can't do it.
    const { data } = await supabase.from('customers').select('name, phone, contact_phone').not('phone', 'is', null).limit(1000)
    const want = new Set(phones.map(digits))
    for (const c of data || []) {
      for (const p of [c.phone, c.contact_phone]) {
        const d = digits(p)
        if (d && want.has(d)) byPhone[d] = byPhone[d] || c.name
      }
    }
  }
  for (const r of rows) {
    r.customerName = byId[r.customer_id] || null
    if (!r.customerName && r.channel === 'email') r.customerName = byEmail[String(r.to_email || '').toLowerCase()] || null
    if (!r.customerName && r.channel === 'sms') r.customerName = byPhone[digits(r.direction === 'out' ? r.to_number : r.from_number)] || null
  }
  return rows
}

export async function searchCustomers(term) {
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, email, phone')
    .ilike('name', `%${term}%`)
    .order('name')
    .limit(8)
  if (error) throw error
  return data || []
}

// Live updates: prepend fresh rows as they land.
export function subscribeComms(onNew) {
  const channel = supabase
    .channel('comms-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sms_messages' }, (p) => onNew({ ...p.new, channel: 'sms' }))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'email_messages' }, (p) => onNew({ ...p.new, channel: 'email' }))
    .subscribe()
  return () => supabase.removeChannel(channel)
}
