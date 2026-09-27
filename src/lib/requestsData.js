// Client portal requests as triageable tickets: the Dashboard banner shows
// every open one (status != done) until a staff member marks it scheduled or
// handled. Replies go out by email through the gmail-oauth function.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'
import { addProperty } from './customersData.js'

export const KIND_LABELS = {
  extra_pickup: 'Extra pickup',
  junk_removal: 'Junk removal',
  lawn_care: 'Lawn care',
  billing: 'Billing',
  other: 'Service request',
  new_property: 'New property',
}
export const STATUS_META = {
  new: { label: 'New', color: '#b3261e', bg: '#fdecea' },
  seen: { label: 'Seen', color: '#8a6320', bg: '#fdf2e0' },
  scheduled: { label: 'Scheduled', color: '#155e9c', bg: '#e7f0f9' },
  done: { label: 'Handled', color: '#1f7a4d', bg: '#e7f1eb' },
}

// Open tickets, newest first, with the client's name/email and property
// addresses resolved (property_ids is a plain uuid[] — no FK embedding).
export async function loadOpenRequests() {
  const { data, error } = await supabase
    .from('portal_requests')
    .select('id,kind,message,status,created_at,notified_at,replied_at,replied_by,resolved_at,resolved_by,resolution_note,customer_id,property_ids,photos,details,customers(name,email)')
    .neq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  const rows = data || []
  const propIds = [...new Set(rows.flatMap((r) => r.property_ids || []))]
  const addrOf = {}
  if (propIds.length) {
    const { data: props } = await supabase.from('properties').select('id,address').in('id', propIds)
    ;(props || []).forEach((p) => { if (p.address) addrOf[p.id] = p.address })
  }
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    name: r.customers?.name || 'A client',
    email: r.customers?.email || '',
    kind: r.kind,
    kindLabel: KIND_LABELS[r.kind] || r.kind,
    // structured new-property answers (mig 0060): {address, days[], frequency, notes}
    details: r.details || null,
    message: r.message || '',
    status: r.status,
    createdAt: r.created_at,
    notifiedAt: r.notified_at,
    repliedAt: r.replied_at,
    repliedBy: r.replied_by,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    addresses: (r.property_ids || []).map((id) => addrOf[id]).filter(Boolean),
    // client-attached photos (mig 0059) — public URLs from the stop-photos bucket
    photoUrls: (r.photos || []).map((p) => supabase.storage.from('stop-photos').getPublicUrl(p).data.publicUrl),
  }))
}

// Keep the banner honest while the dashboard is open.
export function subscribeOpenRequests(cb) {
  const channel = supabase
    .channel('portal-requests-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'portal_requests' }, cb)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

// new → scheduled → done. 'done' is the only one that closes the ticket.
export async function setRequestStatus(req, status, note) {
  const patch = { status }
  if (status === 'done') {
    patch.resolved_at = new Date().toISOString()
    if (note) patch.resolution_note = note
  }
  const { error } = await supabase.from('portal_requests').update(patch).eq('id', req.id)
  if (error) throw error
  const verb = status === 'done' ? 'Handled' : status === 'scheduled' ? 'Scheduled' : 'Updated'
  logActivity({
    type: 'request_' + status,
    summary: `${verb} portal request from ${req.name}${note ? ` — ${note}` : ''}`,
    entityType: 'customer',
    entityId: req.customerId,
  })
}

// ---- New-property approval (mig 0060) --------------------------------------
// Next local date whose weekday is in `days` — default start date when
// approving a new-property request (today counts if the day matches).
export function nextDateForDays(days, from = new Date()) {
  const want = new Set(days || [])
  if (!want.size) return null
  const NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let i = 0; i < 8; i++) {
    if (want.has(NAMES[d.getDay()])) return d.toISOString().slice(0, 10)
    d.setDate(d.getDate() + 1)
  }
  return null
}

// Approve a new_property portal request: create the property with the client's
// requested days/frequency/notes (the triage panel lets staff adjust first),
// then close the ticket. The property insert skips the staff alert — the
// client's original submission already texted/emailed/pushed everyone, and a
// second blast would be noise.
export async function approveNewPropertyRequest(req, opts = {}) {
  const d = req.details || {}
  if (!d.address || !(d.days || []).length) throw new Error('This request is missing the address or service days.')
  const days = opts.days || d.days
  const propertyId = await addProperty(req.customerId, {
    address: d.address,
    notes: opts.notes ?? (d.notes || null),
    price: opts.price ?? null,
    pickup_days: days,
    pickup_frequency: opts.frequency || d.frequency || 'weekly',
    pickup_start_date: opts.startDate || nextDateForDays(days),
  }, { notify: false })
  await setRequestStatus(req, 'done', `Approved — added ${d.address} to the schedule`)
  logActivity({
    type: 'property_approved',
    summary: `Approved new property for ${req.name}: ${d.address}`,
    entityType: 'property',
    entityId: propertyId,
  })
  return propertyId
}

// Reply to a request by email — sends from the connected company Gmail.
export async function replyToRequestEmail({ requestId, customerId, customerName, to, subject, text }) {
  const { data, error } = await supabase.functions.invoke('gmail-oauth', {
    body: { action: 'send', to, subject, text, portal_request_id: requestId, customer_id: customerId, customer_name: customerName },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}
