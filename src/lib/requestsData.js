// Client portal requests as triageable tickets: the Dashboard banner shows
// every open one (status != done) until a staff member marks it scheduled or
// handled. Replies go out by email through the gmail-oauth function.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'

export const KIND_LABELS = {
  extra_pickup: 'Extra pickup',
  junk_removal: 'Junk removal',
  lawn_care: 'Lawn care',
  billing: 'Billing',
  other: 'Service request',
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
    .select('id,kind,message,status,created_at,notified_at,replied_at,replied_by,resolved_at,resolved_by,resolution_note,customer_id,property_ids,customers(name,email)')
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
    message: r.message || '',
    status: r.status,
    createdAt: r.created_at,
    notifiedAt: r.notified_at,
    repliedAt: r.replied_at,
    repliedBy: r.replied_by,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    addresses: (r.property_ids || []).map((id) => addrOf[id]).filter(Boolean),
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

// Reply to a request by email — sends from the connected company Gmail.
export async function replyToRequestEmail({ requestId, customerId, customerName, to, subject, text }) {
  const { data, error } = await supabase.functions.invoke('gmail-oauth', {
    body: { action: 'send', to, subject, text, portal_request_id: requestId, customer_id: customerId, customer_name: customerName },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}
