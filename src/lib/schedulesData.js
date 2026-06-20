// Data layer for recurring pickup schedules (one row per customer pickup).
// Joined to the customer so the Schedules view can group/show context.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'

export const FREQUENCIES = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Every 2 weeks'],
  ['monthly', 'Monthly'],
  ['1st_3rd', '1st & 3rd week'],
  ['2nd_4th', '2nd & 4th week'],
  ['on_call', 'On call'],
]
export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

export const freqLabel = (f) => (FREQUENCIES.find((x) => x[0] === f) || [f, f])[1]

function mapSchedule(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customers?.name || 'Unknown',
    customerAddress: row.customers?.address || '',
    customerStatus: row.customers?.status || 'active',
    service: row.service || '',
    frequency: row.frequency,
    dayOfWeek: row.day_of_week || '',
    startDate: row.start_date,
    active: row.active !== false,
    notes: row.notes || '',
    createdAt: row.created_at,
  }
}

export async function loadSchedules() {
  const { data, error } = await supabase
    .from('pickup_schedules')
    .select('*, customers(name,address,status)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapSchedule)
}

export async function createSchedule(payload) {
  const { data, error } = await supabase
    .from('pickup_schedules')
    .insert({
      customer_id: payload.customerId,
      service: (payload.service || '').trim() || null,
      frequency: payload.frequency || 'weekly',
      day_of_week: payload.frequency === 'on_call' ? null : payload.dayOfWeek || null,
      start_date: payload.startDate || null,
      active: payload.active !== false,
      notes: (payload.notes || '').trim() || null,
    })
    .select('id')
    .single()
  if (error) throw error
  logActivity({ type: 'schedule_created', summary: `Added ${freqLabel(payload.frequency || 'weekly')} pickup for ${payload.customerName || 'a client'}`, entityType: 'schedule', entityId: data.id })
  return data.id
}

export async function updateSchedule(id, payload) {
  const patch = {}
  if ('service' in payload) patch.service = (payload.service || '').trim() || null
  if ('frequency' in payload) {
    patch.frequency = payload.frequency
    if (payload.frequency === 'on_call') patch.day_of_week = null
  }
  if ('dayOfWeek' in payload && payload.frequency !== 'on_call') patch.day_of_week = payload.dayOfWeek || null
  if ('startDate' in payload) patch.start_date = payload.startDate || null
  if ('active' in payload) patch.active = payload.active
  if ('notes' in payload) patch.notes = (payload.notes || '').trim() || null
  const { error } = await supabase.from('pickup_schedules').update(patch).eq('id', id)
  if (error) throw error
}

export async function toggleScheduleActive(id, active) {
  const { error } = await supabase.from('pickup_schedules').update({ active }).eq('id', id)
  if (error) throw error
}

export async function deleteSchedule(id) {
  const { error } = await supabase.from('pickup_schedules').delete().eq('id', id)
  if (error) throw error
}

export function subscribeSchedules(cb) {
  const channel = supabase
    .channel('schedules-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pickup_schedules' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, cb)
    .subscribe()
  return () => supabase.removeChannel(channel)
}
