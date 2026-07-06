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
