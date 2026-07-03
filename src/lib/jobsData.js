// One-time jobs (Junk Removal): calendar-scheduled, not routed.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'

const mapJob = (row) => ({
  id: row.id,
  line: row.business_line,
  customerId: row.customer_id,
  customerName: row.customers?.name || '',
  address: row.address || '',
  date: row.scheduled_date,
  window: row.time_window || '',
  status: row.status,
  amount: row.amount,
  driverId: row.driver_id,
  driverName: row.driver?.full_name || '',
  notes: row.notes || '',
  routeStopId: row.route_stop_id,
})

// All jobs in a month (line-scoped). monthStart = 'YYYY-MM-01'.
export async function loadJobsForMonth(line, monthStart) {
  const start = new Date(monthStart + 'T00:00:00')
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
  const endStr = end.toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('jobs')
    .select('*, customers(name), driver:profiles(full_name)')
    .eq('business_line', line)
    .gte('scheduled_date', monthStart)
    .lt('scheduled_date', endStr)
    .order('scheduled_date', { ascending: true })
  if (error) throw error
  return (data || []).map(mapJob)
}

export async function createJob(line, payload) {
  const row = {
    business_line: line,
    customer_id: payload.customerId || null,
    address: (payload.address || '').trim() || null,
    scheduled_date: payload.date,
    time_window: (payload.window || '').trim() || null,
    amount: payload.amount === '' || payload.amount == null ? null : Number(payload.amount),
    driver_id: payload.driverId || null,
    notes: (payload.notes || '').trim() || null,
  }
  const { data, error } = await supabase.from('jobs').insert(row).select('*, customers(name), driver:profiles(full_name)').single()
  if (error) throw error
  logActivity({ type: 'job_created', summary: `Scheduled a ${line} job${row.address ? ` at ${row.address}` : ''} for ${payload.date}`, entityType: 'job', entityId: data.id })
  return mapJob(data)
}

export async function updateJob(id, patch) {
  const row = { ...patch, updated_at: new Date().toISOString() }
  const { error } = await supabase.from('jobs').update(row).eq('id', id)
  if (error) throw error
}

export async function setJobStatus(id, status, label) {
  await updateJob(id, { status })
  logActivity({ type: `job_${status}`, summary: `${status === 'done' ? 'Completed' : status === 'canceled' ? 'Canceled' : 'Rescheduled'} job${label ? ` — ${label}` : ''}`, entityType: 'job', entityId: id })
}

export async function deleteJob(id) {
  const { error } = await supabase.from('jobs').delete().eq('id', id)
  if (error) throw error
}

export function subscribeJobs(cb) {
  const ch = supabase
    .channel('jobs-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, cb)
    .subscribe()
  return () => supabase.removeChannel(ch)
}
