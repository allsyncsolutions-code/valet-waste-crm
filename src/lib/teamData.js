// Team / staff data. Reads come straight from `profiles` (RLS lets any staff
// see all). Mutations (invite / role / remove) go through the admin-gated
// `manage-team` edge function, which holds the service-role key.
import { supabase } from './supabaseClient.js'

export async function loadTeam() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_driver, business_lines, created_at')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

// Staff flagged as drivers — used to populate the route driver dropdown.
export async function loadDrivers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, phone')
    .eq('is_driver', true)
    .order('full_name', { ascending: true })
  if (error) throw error
  return data || []
}

async function call(body) {
  const { data, error } = await supabase.functions.invoke('manage-team', { body })
  if (error) {
    // Surface the function's JSON error message when present.
    let msg = error.message || 'Request failed'
    try {
      const ctx = error.context && (await error.context.json())
      if (ctx && ctx.error) msg = ctx.error
    } catch (e) {}
    throw new Error(msg)
  }
  if (data && data.error) throw new Error(data.error)
  return data
}

export const inviteMember = ({ email, full_name, role, password }) =>
  call({ action: 'invite', email, full_name, role, password })

export const setMemberRole = (id, role) => call({ action: 'set_role', id, role })

export const setMemberDriver = (id, is_driver) => call({ action: 'set_driver', id, is_driver })

export const setMemberLines = (id, business_lines) => call({ action: 'set_lines', id, business_lines })

export const removeMember = (id) => call({ action: 'remove', id })

export function subscribeTeam(onChange) {
  const ch = supabase
    .channel('team-profiles')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, onChange)
    .subscribe()
  return () => { try { supabase.removeChannel(ch) } catch (e) {} }
}
