// Estimates (stored in the `quotes` table) — price proposals laid out like
// invoices but answered instead of paid: the client accepts or declines, with
// an optional note on why. This layer mirrors invoicesData: list/create/edit/
// void from the CRM, plus the send paths (link, text, email) and one-click
// conversion into a real invoice once work is greenlit.
import { supabase } from './supabaseClient.js'
import { logActivity } from './activityData.js'
import { sendSms } from './smsData.js'
import { createInvoice } from './invoicesData.js'
import { loadSettings } from './settingsData.js'

const money = (v) => '$' + Number(v || 0).toFixed(2)
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function mapEstimate(row) {
  const cust = row.customers || {}
  return {
    id: row.id,
    number: row.number,
    title: row.title || '',
    notes: row.notes || '',
    lineItems: (row.line_items || []).map((li) => ({
      title: li.title || '',
      description: li.description || '',
      quantity: num(li.quantity),
      unitPrice: num(li.unit_price),
      amount: num(li.amount ?? num(li.quantity) * num(li.unit_price)),
    })),
    subtotal: num(row.subtotal),
    total: num(row.total),
    status: row.status, // draft | sent | approved | declined | void
    sentAt: row.sent_at,
    respondedAt: row.responded_at,
    responseNote: row.response_note || '',
    createdAt: row.created_at,
    createdBy: row.created_by || '',
    customerId: row.customer_id,
    customerName: cust.name || '',
    customerEmail: cust.email || '',
    customerPhone: cust.contact_phone || cust.phone || '',
    customerAddress: cust.address || '',
    businessLine: cust.business_line || 'waste',
  }
}

const SELECT = '*, customers(name,email,phone,contact_phone,address,business_line)'

export async function loadEstimates(line) {
  const { data, error } = await supabase
    .from('quotes')
    .select(SELECT)
    .order('created_at', { ascending: false })
    .limit(300)
  if (error) throw error
  const rows = line ? (data || []).filter((r) => (r.customers?.business_line || 'waste') === line) : (data || [])
  return rows.map(mapEstimate)
}

// Create + send in one step (the normal path): the estimate appears in the
// client's portal immediately, ready to accept or decline.
export async function createEstimate(payload) {
  const items = (payload.items || [])
    .filter((it) => (it.title || '').trim() || (it.description || '').trim())
    .map((it) => ({
      title: (it.title || '').trim() || null,
      description: (it.description || '').trim() || null,
      quantity: num(it.quantity) || 1,
      unit_price: num(it.unitPrice),
      amount: num(it.quantity || 1) * num(it.unitPrice),
    }))
  if (!items.length) throw new Error('Add at least one line item.')
  const subtotal = items.reduce((s, li) => s + li.amount, 0)
  const { data: me } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('quotes')
    .insert({
      customer_id: payload.customerId,
      title: (payload.title || '').trim() || null,
      notes: (payload.notes || '').trim() || null,
      line_items: items,
      subtotal,
      total: subtotal,
      status: 'sent',
      sent_at: new Date().toISOString(),
      created_by: me?.user?.email || null,
    })
    .select('id, number')
    .single()
  if (error) throw error
  logActivity({ type: 'estimate_created', summary: `Sent estimate ${data.number} to ${payload.customerName || 'client'} (${money(subtotal)})`, entityType: 'quote', entityId: data.id, meta: { total: subtotal } })
  return data.id
}

// Rewrite title/notes/line items while the estimate is still awaiting a
// response (draft or sent). Kept off approved/declined/void rows — a document
// the client answered stays exactly what they saw.
export async function updateEstimate(id, payload) {
  const items = (payload.items || [])
    .filter((it) => (it.title || '').trim() || (it.description || '').trim())
    .map((it) => ({
      title: (it.title || '').trim() || null,
      description: (it.description || '').trim() || null,
      quantity: num(it.quantity) || 1,
      unit_price: num(it.unitPrice),
      amount: num(it.quantity || 1) * num(it.unitPrice),
    }))
  if (!items.length) throw new Error('Add at least one line item.')
  const subtotal = items.reduce((s, li) => s + li.amount, 0)
  const { error } = await supabase
    .from('quotes')
    .update({
      title: (payload.title || '').trim() || null,
      notes: (payload.notes || '').trim() || null,
      line_items: items,
      subtotal,
      total: subtotal,
    })
    .eq('id', id)
  if (error) throw error
  logActivity({ type: 'estimate_updated', summary: `Updated estimate ${payload.number || ''}`.trim(), entityType: 'quote', entityId: id })
}

export async function voidEstimate(est) {
  const { error } = await supabase.from('quotes').update({ status: 'void' }).eq('id', est.id)
  if (error) throw error
  logActivity({ type: 'estimate_void', summary: `Voided estimate ${est.number}`, entityType: 'quote', entityId: est.id })
}

// --- Send paths (mirror the invoice ones) ------------------------------------

// The standalone accept page link — minted by the portal fn (needs the
// customer's portal slug). Marks nothing; the estimate is already 'sent'.
export async function estimateUrl(quoteId) {
  const { data, error } = await supabase.functions.invoke('portal', {
    body: { action: 'estimate_url', quote_id: quoteId, origin: window.location.origin },
  })
  if (error) {
    let msg = error.message || String(error)
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (e) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data.url
}

// Full-document HTML email with an Accept button (SendGrid, via the portal fn).
export async function emailEstimate(quoteId) {
  const { data, error } = await supabase.functions.invoke('portal', {
    body: { action: 'email_estimate', quote_id: quoteId, origin: window.location.origin },
  })
  if (error) {
    let msg = error.message || String(error)
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error } catch (e) { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

// Text the client their accept link (same opt-out/pause rules as every text).
export async function textEstimate(est) {
  const settings = await loadSettings().catch(() => null)
  const company = settings?.company_name || 'Valet Waste FL'
  const first = String(est.customerName || '').trim().split(/\s+/)[0] || 'there'
  const url = await estimateUrl(est.id)
  const body = `Hi ${first}, your ${company} estimate ${est.number} for ${money(est.total)} is ready — review and accept or decline here: ${url}`
  const r = await sendSms(est.customerPhone, body, { customerId: est.customerId, purpose: 'estimate' })
  if (!r || !r.ok) {
    if (!r || !r.paused) throw new Error((r && r.message) || 'The text could not be sent.')
  }
  logActivity({ type: 'estimate_texted', summary: `Texted estimate ${est.number} to ${est.customerName || 'client'}`, entityType: 'quote', entityId: est.id })
  return r
}

// Turn an estimate into a draft invoice with the same line items — the bridge
// from "accepted" to "billable".
export async function convertEstimateToInvoice(est) {
  const invId = await createInvoice({
    customerId: est.customerId,
    status: 'draft',
    issueDate: new Date().toISOString().slice(0, 10),
    notes: est.notes || '',
    items: est.lineItems.map((li) => ({ title: li.title, description: li.description, quantity: li.quantity, unitPrice: li.unitPrice })),
  })
  logActivity({ type: 'estimate_converted', summary: `Converted estimate ${est.number} into a draft invoice`, entityType: 'quote', entityId: est.id, meta: { invoiceId: invId } })
  return invId
}
