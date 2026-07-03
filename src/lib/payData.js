// Lawn Care employee pay + timesheets.
//
// Pay model: techs are paid PER JOB, not per hour. A stop is PAYABLE when the
// tech checked in AND out AND uploaded at least one photo — or when an admin
// explicitly overrode it (recorded who/when). Clock in/out exists so admins
// can see how long jobs take, but it never drives pay.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'

export const weekStartOf = (d = new Date()) => {
  const x = new Date(d)
  x.setDate(x.getDate() - x.getDay()) // back to Sunday
  return x.toISOString().slice(0, 10)
}
export const addDaysStr = (s, n) => {
  const d = new Date(s + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// All lawn stops in a Sun–Sat week, grouped per tech, with pay status.
export async function loadWeekPay(weekStart) {
  const weekEnd = addDaysStr(weekStart, 6)
  const { data, error } = await supabase
    .from('route_stops')
    .select('id, check_in, check_out, tech_pay, pay_override, pay_override_by, pay_override_at, properties(address, tech_pay, price), routes!inner(code, service_date, driver_id, business_line), stop_photos(id)')
    .eq('routes.business_line', 'lawn')
    .gte('routes.service_date', weekStart)
    .lte('routes.service_date', weekEnd)
  if (error) throw error

  const stops = (data || []).map((s) => {
    const pay = s.tech_pay ?? s.properties?.tech_pay ?? null
    const photos = (s.stop_photos || []).length
    const complete = !!(s.check_in && s.check_out && photos > 0)
    return {
      id: s.id,
      date: s.routes.service_date,
      route: s.routes.code,
      driverId: s.routes.driver_id,
      address: s.properties?.address || '',
      charge: s.properties?.price ?? null,
      pay,
      photos,
      checkedIn: !!s.check_in,
      checkedOut: !!s.check_out,
      payable: complete || !!s.pay_override,
      override: !!s.pay_override,
      overrideBy: s.pay_override_by,
      overrideAt: s.pay_override_at,
      missing: complete ? null : [!s.check_in && 'check-in', s.check_in && !s.check_out && 'check-out', photos === 0 && 'photos'].filter(Boolean).join(' + '),
    }
  })

  const byDriver = {}
  for (const s of stops) {
    const k = s.driverId || '__unassigned__'
    byDriver[k] ||= []
    byDriver[k].push(s)
  }
  return byDriver
}

export async function approveStopPay(stopId, adminName, label) {
  const { error } = await supabase.from('route_stops').update({
    pay_override: true,
    pay_override_by: adminName || 'Admin',
    pay_override_at: new Date().toISOString(),
  }).eq('id', stopId)
  if (error) throw error
  logActivity({ type: 'pay_override', summary: `${adminName || 'Admin'} approved pay override${label ? ` — ${label}` : ''}`, entityType: 'route_stop', entityId: stopId })
}

// ---- timesheets (informational clock in/out) --------------------------------
export async function loadWeekTimesheets(weekStart) {
  const weekEnd = addDaysStr(weekStart, 6)
  const { data, error } = await supabase
    .from('timesheets')
    .select('*')
    .gte('work_date', weekStart)
    .lte('work_date', weekEnd)
  if (error) throw error
  return data || []
}

export async function clockIn(profileId) {
  const today = new Date().toISOString().slice(0, 10)
  const { error } = await supabase.from('timesheets').upsert(
    { profile_id: profileId, work_date: today, clock_in: new Date().toISOString() },
    { onConflict: 'profile_id,work_date', ignoreDuplicates: false },
  )
  if (error) throw error
}

export async function clockOut(profileId) {
  const today = new Date().toISOString().slice(0, 10)
  const { error } = await supabase
    .from('timesheets')
    .update({ clock_out: new Date().toISOString() })
    .eq('profile_id', profileId)
    .eq('work_date', today)
  if (error) throw error
}
