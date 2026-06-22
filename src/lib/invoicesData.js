// Data layer for invoices + line items. Invoices are real billing documents
// (distinct from invoice_schedules, which is the recurring-billing config).
// Stripe payment links are minted through the `stripe` edge function so the
// platform secret key stays server-side.
import { supabase } from './supabaseClient.js'
import { stripePaymentLink } from './stripeData.js'
import { logActivity } from './activityData.js'
import { loadSettings } from './settingsData.js'
import { sendSms, renderTemplate } from './smsData.js'

const DEFAULT_INVOICE_TPL = 'Hi {customerName}, invoice {invoiceNumber} for {total} is ready. Pay here: {payLink} — {companyName}'

const money = (v) => '$' + Number(v || 0).toFixed(2)

export const INVOICE_STATUS = ['draft', 'sent', 'paid', 'void']

const num = (v) => (v == null || v === '' ? 0 : Number(v))
export const round2 = (v) => Math.round(num(v) * 100) / 100

// Compute a line's amount + the invoice subtotal/total from items & discount.
export function lineAmount(item) {
  return round2(num(item.quantity) * num(item.unitPrice))
}
export function invoiceTotals(items, discount = 0) {
  const subtotal = round2((items || []).reduce((s, it) => s + lineAmount(it), 0))
  const total = round2(Math.max(0, subtotal - num(discount)))
  return { subtotal, total }
}

function mapInvoice(row) {
  const items = (row.invoice_line_items || [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((li) => ({
      id: li.id,
      description: li.description || '',
      quantity: num(li.quantity),
      unitPrice: num(li.unit_price),
      amount: num(li.amount),
    }))
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customers?.name || '',
    customerEmail: row.customers?.email || '',
    customerPhone: row.customers?.phone || '',
    customerAddress: row.customers?.address || '',
    number: row.number,
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    notes: row.notes || '',
    discount: num(row.discount),
    subtotal: num(row.subtotal),
    total: num(row.total),
    stripePaymentUrl: row.stripe_payment_url || null,
    sentAt: row.sent_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    items,
  }
}

const SELECT = '*, customers(name,email,phone,address), invoice_line_items(*)'

export async function loadInvoices() {
  const { data, error } = await supabase
    .from('invoices')
    .select(SELECT)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).map(mapInvoice)
}

// Replace all line items for an invoice (simplest correct edit path).
async function writeLineItems(invoiceId, items) {
  const { error: delErr } = await supabase
    .from('invoice_line_items')
    .delete()
    .eq('invoice_id', invoiceId)
  if (delErr) throw delErr
  const rows = (items || [])
    .filter((it) => (it.description || '').trim() || num(it.quantity) || num(it.unitPrice))
    .map((it, i) => ({
      invoice_id: invoiceId,
      description: (it.description || '').trim() || null,
      quantity: num(it.quantity) || 1,
      unit_price: num(it.unitPrice),
      amount: lineAmount(it),
      position: i,
    }))
  if (rows.length) {
    const { error } = await supabase.from('invoice_line_items').insert(rows)
    if (error) throw error
  }
}

// Create a draft invoice for a customer.
export async function createInvoice(payload) {
  const { subtotal, total } = invoiceTotals(payload.items, payload.discount)
  const { data, error } = await supabase
    .from('invoices')
    .insert({
      customer_id: payload.customerId,
      status: payload.status || 'draft',
      issue_date: payload.issueDate || null,
      due_date: payload.dueDate || null,
      notes: (payload.notes || '').trim() || null,
      discount: num(payload.discount),
      subtotal,
      total,
    })
    .select('id, number')
    .single()
  if (error) throw error
  await writeLineItems(data.id, payload.items)
  logActivity({ type: 'invoice_created', summary: `Created invoice ${data.number} (${money(total)})`, entityType: 'invoice', entityId: data.id, meta: { total } })
  return data.id
}

// Update an invoice's header + line items (recomputes totals).
export async function updateInvoice(id, payload) {
  const { subtotal, total } = invoiceTotals(payload.items, payload.discount)
  const { error } = await supabase
    .from('invoices')
    .update({
      customer_id: payload.customerId,
      status: payload.status,
      issue_date: payload.issueDate || null,
      due_date: payload.dueDate || null,
      notes: (payload.notes || '').trim() || null,
      discount: num(payload.discount),
      subtotal,
      total,
    })
    .eq('id', id)
  if (error) throw error
  await writeLineItems(id, payload.items)
  return id
}

export async function setInvoiceStatus(id, status, extra = {}) {
  const patch = { status, ...extra }
  const { error } = await supabase.from('invoices').update(patch).eq('id', id)
  if (error) throw error
}

export async function markPaid(id, number) {
  await setInvoiceStatus(id, 'paid', { paid_at: new Date().toISOString() })
  logActivity({ type: 'invoice_paid', summary: `Marked invoice ${number || ''} paid`.replace('  ', ' ').trim(), entityType: 'invoice', entityId: id })
}

export async function deleteInvoice(id, number) {
  const { error } = await supabase.from('invoices').delete().eq('id', id)
  if (error) throw error
  logActivity({ type: 'invoice_deleted', summary: `Deleted invoice ${number || ''}`.trim(), entityType: 'invoice' })
}

// Mint a Stripe checkout link for the invoice total, store it, and mark sent.
export async function sendInvoiceLink(invoice) {
  if (!invoice.total || invoice.total < 0.5) {
    throw new Error('Invoice total must be at least $0.50 to create a payment link.')
  }
  const d = await stripePaymentLink({
    amount: invoice.total,
    description: `${invoice.number}${invoice.customerName ? ' — ' + invoice.customerName : ''}`,
    customerName: invoice.customerName,
  })
  if (!d || !d.url) throw new Error('Stripe did not return a payment link.')
  await setInvoiceStatus(invoice.id, 'sent', {
    stripe_payment_url: d.url,
    sent_at: new Date().toISOString(),
  })
  logActivity({ type: 'invoice_sent', summary: `Sent payment link for invoice ${invoice.number} (${money(invoice.total)})`, entityType: 'invoice', entityId: invoice.id })
  return d.url
}

// Text the customer their invoice: ensure a pay link exists, render the
// invoice SMS template from settings, send via the sms edge function, and
// mark the invoice sent. Mirrors the old app's purpose:"invoice" trigger.
export async function textInvoice(invoice, customMessage) {
  if (!invoice.customerPhone) throw new Error('This customer has no phone number on file.')

  // Reuse the stored pay link, or mint one (also marks the invoice sent).
  let payUrl = invoice.stripePaymentUrl
  if (!payUrl) payUrl = await sendInvoiceLink(invoice)

  const settings = await loadSettings().catch(() => null)
  const tpl = (customMessage && customMessage.trim()) || settings?.sms_invoice_template || DEFAULT_INVOICE_TPL
  const body = renderTemplate(tpl, {
    customerName: invoice.customerName || 'there',
    invoiceNumber: invoice.number,
    total: money(invoice.total),
    payLink: payUrl,
    companyName: settings?.company_name || 'Valet Waste FL',
  })

  const r = await sendSms(invoice.customerPhone, body, { customerId: invoice.customerId, purpose: 'invoice' })

  if (invoice.status === 'draft') {
    await setInvoiceStatus(invoice.id, 'sent', { sent_at: new Date().toISOString() })
  }
  logActivity({ type: 'invoice_texted', summary: `Texted invoice ${invoice.number} to ${invoice.customerName || 'customer'}`, entityType: 'invoice', entityId: invoice.id })
  return r
}

export function subscribeInvoices(cb) {
  const channel = supabase
    .channel('invoices-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, cb)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_line_items' }, cb)
    .subscribe()
  return () => supabase.removeChannel(channel)
}
