// Admin annotation layer — lets admins point at any element on a screen and
// leave a note ("this button is wrong", "change this label", etc). Notes are
// reviewed on the Annotations screen.
import { supabase } from './supabaseClient.js'

export async function createAnnotation(a) {
  const { data: u } = await supabase.auth.getUser()
  const author = u?.user
  const { data, error } = await supabase
    .from('annotations')
    .insert({
      author_id: author?.id ?? null,
      author_name: author?.user_metadata?.full_name || author?.email || 'Admin',
      view: a.view || null,
      view_title: a.viewTitle || null,
      target_label: a.targetLabel || null,
      target_selector: a.targetSelector || null,
      note: a.note,
      page_path: a.pagePath || null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function loadAnnotations(status = 'all') {
  let q = supabase.from('annotations').select('*').order('created_at', { ascending: false })
  if (status === 'open' || status === 'resolved') q = q.eq('status', status)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

export async function setAnnotationStatus(id, status) {
  const patch = { status, resolved_at: status === 'resolved' ? new Date().toISOString() : null }
  const { error } = await supabase.from('annotations').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteAnnotation(id) {
  const { error } = await supabase.from('annotations').delete().eq('id', id)
  if (error) throw error
}

export async function countOpenAnnotations() {
  const { count, error } = await supabase
    .from('annotations')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')
  if (error) throw error
  return count || 0
}
