// Web Forms — staff-managed public signup forms (mig 0061). The public page
// at /?signup=<slug> renders each row's config; RLS keeps the table staff-only.
import { supabase } from './supabaseClient.js'

const COLS = 'id, name, slug, active, config, created_by, created_at, updated_at'

export async function loadWebForms() {
  const { data, error } = await supabase.from('web_forms').select(COLS).order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

function slugify(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'form'
  const rand = Math.random().toString(36).slice(2, 6)
  return `${base}-${rand}`
}

// config: { intro, pricing: {one_pickup, two_pickup, on_demand_note},
//           line_items: [{description, price|null}], total_label, terms }
export async function saveWebForm({ id, name, slug, active, config }) {
  const numOrBlank = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v) * 100) / 100) || null)
  const payload = {
    name: String(name || '').trim().slice(0, 120) || 'Untitled form',
    active: !!active,
    config: {
      intro: String(config?.intro || '').trim().slice(0, 400) || null,
      pricing: {
        one_pickup: numOrBlank(config?.pricing?.one_pickup),
        two_pickup: numOrBlank(config?.pricing?.two_pickup),
        on_demand_note: String(config?.pricing?.on_demand_note || '').trim().slice(0, 300) || null,
      },
      line_items: (Array.isArray(config?.line_items) ? config.line_items : [])
        .slice(0, 10)
        .map((li) => ({
          description: String(li?.description ?? '').trim().slice(0, 140),
          price: li?.price === '' || li?.price == null ? null : Math.max(0, Math.round(Number(li.price) * 100) / 100) || null,
        }))
        .filter((li) => li.description),
      total_label: String(config?.total_label || '').trim().slice(0, 40) || null,
      terms: String(config?.terms || '').trim().slice(0, 2000) || null,
    },
    updated_at: new Date().toISOString(),
  }
  if (id) {
    const { data, error } = await supabase.from('web_forms').update(payload).eq('id', id).select(COLS).single()
    if (error) throw error
    return data
  }
  const { data, error } = await supabase
    .from('web_forms')
    .insert({ ...payload, slug: slug || slugify(payload.name), created_by: 'crm' })
    .select(COLS)
    .single()
  if (error) throw error
  return data
}

export async function duplicateWebForm(form) {
  return saveWebForm({
    name: `${form.name} (copy)`,
    active: form.active,
    config: form.config,
  })
}

export async function deleteWebForm(id) {
  const { error } = await supabase.from('web_forms').delete().eq('id', id)
  if (error) throw error
}
