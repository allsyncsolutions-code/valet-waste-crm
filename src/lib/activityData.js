// Activity log — one row per noteworthy action. Writes are best-effort: a
// logging failure must never break the underlying action, so logActivity
// swallows its own errors.
import { supabase } from './supabaseClient.js'

// Fire-and-forget. Pass { type, summary, actor?, entityType?, entityId?, meta? }.
export async function logActivity(event) {
  try {
    await supabase.from('activity_log').insert({
      type: event.type,
      actor: event.actor || 'You',
      summary: event.summary,
      entity_type: event.entityType || null,
      entity_id: event.entityId || null,
      meta: event.meta || null,
    })
  } catch (e) {
    // intentionally ignored — logging is non-critical
  }
}

function mapEntry(row) {
  return {
    id: row.id,
    type: row.type,
    actor: row.actor || 'You',
    summary: row.summary,
    entityType: row.entity_type,
    entityId: row.entity_id,
    meta: row.meta || null,
    createdAt: row.created_at,
  }
}

export async function loadActivity(limit = 200) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []).map(mapEntry)
}

export function subscribeActivity(cb) {
  const channel = supabase
    .channel('activity-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log' }, cb)
    .subscribe()
  return () => supabase.removeChannel(channel)
}
