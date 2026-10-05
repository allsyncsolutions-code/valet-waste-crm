// Notifications center data: the global per-type toggles live on the
// app_settings singleton (notification_toggles JSONB, migration 0065).
// Per-client opt-outs need no new storage — they already exist as the
// customers.notify_on_service / notify_sms / notify_email flags that the
// portal bell card and the notify-prefs opt-out page set.
import { supabase } from './supabaseClient.js'

// All known toggle keys and their default state (ON). Merging defaults means
// a row written before this column existed (or a partially-seeded one) still
// renders every switch.
export const TOGGLE_DEFAULTS = {
  client_arrival: true,
  client_complete: true,
  client_invoice_email: true,
  client_invoice_sms: true,
  client_portal_invite: true,
  client_service_reminder: true,
  team_new_property: true,
  team_payment_events: true,
  team_automation_alerts: true,
}

export async function loadNotificationToggles() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('notification_toggles')
    .eq('id', 1)
    .maybeSingle()
  if (error) throw error
  const stored = data?.notification_toggles || {}
  // Normalize: any key missing from the stored map defaults to ON, and keys
  // we no longer recognize are dropped.
  const out = {}
  for (const k of Object.keys(TOGGLE_DEFAULTS)) out[k] = stored[k] !== false
  return out
}

export async function saveNotificationToggles(toggles) {
  const { error } = await supabase
    .from('app_settings')
    .update({ notification_toggles: toggles, updated_at: new Date().toISOString() })
    .eq('id', 1)
  if (error) throw error
}

// Clients who turned off at least one notification channel. Everyone NOT in
// this list is fully opted in — the tab leans on that assumption so staff
// don't have to scroll thousands of "on" rows.
export async function loadNotificationOptOuts() {
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, notify_on_service, notify_sms, notify_email')
    .or('notify_on_service.eq.false,notify_sms.eq.false,notify_email.eq.false')
    .order('name')
  if (error) throw error
  return data || []
}

// Turn one or more channels back on for a client. `fields` picks among
// 'notify_on_service' | 'notify_sms' | 'notify_email'.
export async function reEnableNotifications(customerId, fields) {
  const patch = {}
  for (const f of fields) patch[f] = true
  const { error } = await supabase.from('customers').update(patch).eq('id', customerId)
  if (error) throw error
}
