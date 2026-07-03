// Automations catalog — scheduled jobs Trashy Randy runs plus suggestions he
// (or staff, via him) has logged. Reviewed and approved on the Automations tab.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'

export async function loadAutomations() {
  const { data, error } = await supabase
    .from('automations')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export async function setAutomationStatus(id, status, name) {
  const { error } = await supabase
    .from('automations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
  const verb = status === 'enabled' ? 'Enabled' : status === 'paused' ? 'Paused' : 'Updated'
  logActivity({ type: 'automation_' + status, summary: `${verb} automation "${name}"` })
}

export async function deleteAutomation(id, name) {
  const { error } = await supabase.from('automations').delete().eq('id', id)
  if (error) throw error
  logActivity({ type: 'automation_deleted', summary: `Deleted automation "${name}"` })
}

// Trigger the runner now (all enabled automations, or one kind).
export async function runAutomationsNow(kind) {
  const { data, error } = await supabase.functions.invoke('automations-run', {
    body: kind ? { kind } : {},
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}
