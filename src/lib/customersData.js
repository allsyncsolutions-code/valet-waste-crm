// Data layer for customers + their pickup schedule + invoice schedule.
// Shared by the Clients view (form) and the AI assistant (edge function writes
// to the same tables, so realtime keeps everything in sync).
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'

function mapCustomer(row) {
  const pickup = (row.pickup_schedules || [])[0] || null
  const invoice = (row.invoice_schedules || [])[0] || null
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name || '',
    email: row.email || '',
    phone: row.phone || '',
    address: row.address || '',
    status: row.status || 'active',
    notes: row.notes || '',
    portal_slug: row.portal_slug || null,
    business_line: row.business_line || 'waste',
    autopay: {
      saved: !!row.autopay_pm_id,
      brand: row.autopay_card_brand || null,
      last4: row.autopay_card_last4 || null,
    },
    tags: (row.customer_tags || []).map((ct) => ct.tag).filter(Boolean),
    createdAt: row.created_at,
    pickup: pickup
      ? { service: pickup.service || '', frequency: pickup.frequency, dayOfWeek: pickup.day_of_week || '' }
      : null,
    invoice: invoice
      ? { cadence: invoice.cadence, amount: invoice.amount }
      : null,
  }
}

export async function loadCustomers() {
  const { data, error } = await supabase
    .from('customers')
    .select('*, pickup_schedules(*), invoice_schedules(*), customer_tags(tag:tags(id,name,color))')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapCustomer)
}

// Create a customer plus (optionally) a pickup schedule and invoice schedule.
export async function createClient(payload) {
  const { data: customer, error: cErr } = await supabase
    .from('customers')
    .insert({
      name: payload.name,
      contact_name: payload.contactName || null,
      email: payload.email || null,
      phone: payload.phone || null,
      address: payload.address || null,
      status: payload.status || 'active',
      notes: payload.notes || null,
      business_line: payload.businessLine || 'waste',
    })
    .select('*')
    .single()
  if (cErr) throw cErr

  if (payload.pickup) {
    const { error } = await supabase.from('pickup_schedules').insert({
      customer_id: customer.id,
      service: payload.pickup.service || null,
      frequency: payload.pickup.frequency || 'weekly',
      day_of_week: payload.pickup.dayOfWeek || null,
      start_date: payload.pickup.startDate || null,
    })
    if (error) throw error
  }

  if (payload.invoice) {
    const { error } = await supabase.from('invoice_schedules').insert({
      customer_id: customer.id,
      cadence: payload.invoice.cadence || 'monthly',
      amount: payload.invoice.amount ?? null,
      next_invoice_date: payload.invoice.nextInvoiceDate || null,
    })
    if (error) throw error
  }
  logActivity({ type: 'client_created', summary: `Added client ${customer.name}`, entityType: 'customer', entityId: customer.id })
  return customer.id
}

// Update a customer's core fields plus its (single) pickup + invoice schedule.
export async function updateCustomer(id, payload) {
  const { error: cErr } = await supabase
    .from('customers')
    .update({
      name: payload.name,
      contact_name: payload.contactName || null,
      email: payload.email || null,
      phone: payload.phone || null,
      address: payload.address || null,
      status: payload.status || 'active',
      notes: payload.notes || null,
    })
    .eq('id', id)
  if (cErr) throw cErr

  if (payload.pickup) {
    const { data: ex } = await supabase.from('pickup_schedules').select('id').eq('customer_id', id).limit(1)
    const fields = {
      service: payload.pickup.service || null,
      frequency: payload.pickup.frequency || 'weekly',
      day_of_week: payload.pickup.dayOfWeek || null,
    }
    if (ex && ex[0]) await supabase.from('pickup_schedules').update(fields).eq('id', ex[0].id)
    else await supabase.from('pickup_schedules').insert({ customer_id: id, ...fields })
  }

  if (payload.invoice) {
    const { data: ex } = await supabase.from('invoice_schedules').select('id').eq('customer_id', id).limit(1)
    const fields = { cadence: payload.invoice.cadence || 'monthly', amount: payload.invoice.amount ?? null }
    if (ex && ex[0]) await supabase.from('invoice_schedules').update(fields).eq('id', ex[0].id)
    else await supabase.from('invoice_schedules').insert({ customer_id: id, ...fields })
  }
  logActivity({ type: 'client_updated', summary: `Updated client ${payload.name}`, entityType: 'customer', entityId: id })
}

// Properties (service locations) belonging to a customer.
export async function loadProperties(customerId) {
  const { data, error } = await supabase
    .from('properties')
    .select('id, code, name, address, service, notes, price, tech_pay, lat, lng, pickup_days, pickup_frequency, pickup_start_date, needs_review')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

// Add one property (service address) to a customer. lat/lng stay null so the
// geocode-pending pass fills them in afterward.
export async function addProperty(customerId, fields) {
  const { data, error } = await supabase
    .from('properties')
    .insert({
      customer_id: customerId,
      code: fields.code || null,
      name: fields.name || fields.address,
      address: fields.address,
      service: fields.service || null,
      notes: fields.notes || null,
      price: fields.price ?? null,
      tech_pay: fields.tech_pay ?? null,
      pickup_days: fields.pickup_days || [],
      pickup_frequency: fields.pickup_frequency || 'weekly',
    })
    .select('id')
    .single()
  if (error) throw error
  logActivity({ type: 'property_added', summary: `Added address ${fields.address}`, entityType: 'property', entityId: data.id })
  return data.id
}

// Field activity for one client across ALL their properties: on-my-way,
// clock-ins, completions, and job photos — each event carries the address.
export async function loadClientFieldActivity(customerId, limit = 300) {
  const { data, error } = await supabase
    .from('route_stops')
    .select('id, check_in, check_out, on_my_way_at, properties!inner(customer_id, address), routes(code, service_date), stop_photos(id, created_at)')
    .eq('properties.customer_id', customerId)
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw error
  const events = []
  for (const s of data || []) {
    const address = s.properties?.address || ''
    const route = s.routes?.code || null
    if (s.on_my_way_at) events.push({ id: `${s.id}-omw`, ts: s.on_my_way_at, type: 'On my way', icon: '🚐', address, route })
    if (s.check_in) events.push({ id: `${s.id}-in`, ts: s.check_in, type: 'Clocked in', icon: '⏱', address, route })
    if (s.check_out) events.push({ id: `${s.id}-out`, ts: s.check_out, type: 'Completed', icon: '✓', address, route })
    for (const p of s.stop_photos || []) events.push({ id: `${s.id}-ph-${p.id}`, ts: p.created_at, type: 'Photo added', icon: '📷', address, route })
  }
  events.sort((a, b) => new Date(b.ts) - new Date(a.ts))
  return events
}

// Email the client a portal invite: one-time login link (7-day expiry) plus
// the save-a-card pitch (autopay + 5th week free). Staff JWT required.
export async function sendPortalInvite(customerId) {
  const { data, error } = await supabase.functions.invoke('portal', {
    body: { action: 'admin_invite', customer_id: customerId },
  })
  if (error) {
    let msg = error.message || String(error)
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (e) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

// Lightweight index for client search: customer_id → all its property
// addresses (lowercased, space-joined) so the Clients list can match on them.
export async function loadPropertyAddressIndex() {
  const { data, error } = await supabase.from('properties').select('customer_id, address')
  if (error) throw error
  const idx = {}
  for (const r of data || []) {
    if (!r.customer_id || !r.address) continue
    idx[r.customer_id] = (idx[r.customer_id] ? idx[r.customer_id] + ' ' : '') + r.address.toLowerCase()
  }
  return idx
}

// Duplicate-address detection (normalized match across ALL clients).
export async function findDuplicateProperties() {
  const { data, error } = await supabase.rpc('find_duplicate_properties')
  if (error) throw error
  return data || []
}
export async function countDuplicateProperties() {
  const { data, error } = await supabase.rpc('count_duplicate_properties')
  if (error) throw error
  return data || 0
}

// Merge duplicate copies into the kept property: unions pickup days onto it,
// flags it needs_review, and deletes the other copies.
export async function mergeProperties(keepId, removeIds) {
  const { data, error } = await supabase.rpc('merge_properties', { keep_id: keepId, remove_ids: removeIds })
  if (error) throw error
  return data
}
export async function deleteProperty(id) {
  const { data, error } = await supabase.rpc('delete_property', { p_id: id })
  if (error) throw error
  return data
}

// Recent service visits (check-ins/outs) for one property, newest first.
// Pulled from route_stops where a driver actually checked in.
export async function loadPropertyVisits(propertyId, limit = 20) {
  const { data, error } = await supabase
    .from('route_stops')
    .select('id, check_in, check_out, status')
    .eq('property_id', propertyId)
    .not('check_in', 'is', null)
    .order('check_in', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

// Update a property. Editing the address clears its coordinates and resets the
// geocode-attempt counter so it gets re-geocoded on the next pass.
export async function updateProperty(id, patch) {
  const fields = {}
  for (const k of ['code', 'name', 'address', 'service', 'notes', 'price', 'tech_pay', 'pickup_days', 'pickup_frequency', 'needs_review']) {
    if (patch[k] !== undefined) fields[k] = patch[k]
  }
  if (patch.pickup_start_date !== undefined) fields.pickup_start_date = patch.pickup_start_date || null
  if (patch.address !== undefined) { fields.lat = null; fields.lng = null; fields.geocode_attempts = 0 }
  const { error } = await supabase.from('properties').update(fields).eq('id', id)
  if (error) throw error
}

// Link / unlink a managed tag to a customer.
export async function attachTag(customerId, tagId) {
  const { error } = await supabase
    .from('customer_tags')
    .upsert({ customer_id: customerId, tag_id: tagId })
  if (error) throw error
}
export async function detachTag(customerId, tagId) {
  const { error } = await supabase
    .from('customer_tags')
    .delete()
    .eq('customer_id', customerId)
    .eq('tag_id', tagId)
  if (error) throw error
}

// Delete a customer (schedules cascade via FK on delete cascade).
export async function deleteClient(id, name) {
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) throw error
  logActivity({ type: 'client_deleted', summary: `Deleted client ${name || ''}`.trim(), entityType: 'customer' })
}

// Live updates whenever any customer / schedule row changes (form or AI).
export function subscribeCustomers(cb) {
  const channel = supabase
    .channel('customers-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pickup_schedules' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_schedules' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_tags' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tags' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'properties' }, cb)
    .subscribe()
  return () => supabase.removeChannel(channel)
}
