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

// Properties (service locations) belonging to a customer.
export async function loadProperties(customerId) {
  const { data, error } = await supabase
    .from('properties')
    .select('id, code, name, address, service, notes, price, lat, lng')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
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
