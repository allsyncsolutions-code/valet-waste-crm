// Managed tag list — the canonical set of tags with shared colors. Customers
// link to these via the customer_tags join, so renaming/recoloring a tag here
// updates it everywhere it's used.
import { supabase } from './supabaseClient.js'

export const TAG_COLORS = [
  '#1f7a4d', '#2f6db0', '#b07a1e', '#7a4ba0',
  '#c0492f', '#2f8f8f', '#5f7d1f', '#9a3b6e',
]

export async function listTags() {
  const { data, error } = await supabase.from('tags').select('*').order('name')
  if (error) throw error
  return data || []
}

export async function createTag(name, color) {
  const { data, error } = await supabase
    .from('tags')
    .insert({ name: name.trim(), color: color || TAG_COLORS[0] })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function updateTag(id, patch) {
  const { error } = await supabase.from('tags').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteTag(id) {
  const { error } = await supabase.from('tags').delete().eq('id', id)
  if (error) throw error
}

// Return an existing tag by (case-insensitive) name, or create it.
export async function findOrCreateTag(name) {
  const n = (name || '').trim()
  if (!n) return null
  const { data: existing } = await supabase.from('tags').select('*').ilike('name', n).limit(1)
  if (existing && existing.length) return existing[0]
  const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)]
  return await createTag(n, color)
}

// Usage counts per tag id (for the settings list).
export async function tagUsageCounts() {
  const { data, error } = await supabase.from('customer_tags').select('tag_id')
  if (error) throw error
  const counts = {}
  for (const r of data || []) counts[r.tag_id] = (counts[r.tag_id] || 0) + 1
  return counts
}

export function subscribeTags(cb) {
  const ch = supabase
    .channel('tags-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tags' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_tags' }, cb)
    .subscribe()
  return () => supabase.removeChannel(ch)
}
