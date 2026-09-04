// Data layer for invoices + line items. Invoices are real billing documents
// (distinct from invoice_schedules, which is the recurring-billing config).
// Payment links are minted through the `payments` edge function (Run Merchant)
// so merchant credentials stay server-side.
import { supabase } from './supabaseClient.js'
import { invoicePaymentUrl, emailInvoice as emailInvoicePay } from './paymentsData.js'
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
      title: li.title || '',
      description: li.description || '',
      quantity: num(li.quantity),
      unitPrice: num(li.unit_price),
      amount: num(li.amount),
      stopId: li.stop_id || null,
    }))
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customers?.name || '',
    customerEmail: row.customers?.email || '',
    customerPhone: row.customers?.phone || '',
    customerAddress: row.customers?.address || '',
    // Card on file (Run Merchant vault) — powers the staff "Take payment"
    // modal's charge-saved-card shortcut.
    savedCard: row.customers?.run_vault_id
      ? { brand: row.customers.run_card_brand || 'card', last4: row.customers.run_card_last4 || '••••' }
      : null,
    number: row.number,
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    notes: row.notes || '',
    discount: num(row.discount),
    subtotal: num(row.subtotal),
    total: num(row.total),
    tipAmount: num(row.tip_amount),
    stripePaymentUrl: row.payment_url || row.stripe_payment_url || null,
    paymentUrl: row.payment_url || row.stripe_payment_url || null,
    runTransId: row.run_trans_id || null,
    sentAt: row.sent_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    items,
  }
}

const SELECT = '*, customers(name,email,phone,address,business_line,run_vault_id,run_card_brand,run_card_last4), invoice_line_items(*)'

export async function loadInvoices(line) {
  const { data, error } = await supabase
    .from('invoices')
    .select(SELECT)
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = line ? (data || []).filter((r) => (r.customers?.business_line || 'waste') === line) : (data || [])
  return rows.map(mapInvoice)
}

// One client's invoices, newest first — powers the Invoices card in the
// client record (Clients tab).
export async function loadInvoicesForCustomer(customerId, limit = 25) {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, number, status, issue_date, due_date, subtotal, total, tip_amount, sent_at, paid_at, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

// Same history, but ALSO catches invoices stranded on duplicate client rows:
// other customers who share this client's email or phone, or who own a
// property with the same normalized service address. Matched rows come back
// with `matchReason` ('email' | 'phone' | 'address') + `matchName` so the UI
// can flag where they came from; the client's own rows have no matchReason.
export async function loadInvoicesForCustomerSmart(customerId, limit = 40) {
  const dig = (p) => String(p || '').replace(/\D/g, '').slice(-10) // last 10 digits
  const norm = (e) => String(e || '').trim().toLowerCase()

  const [{ data: me }, { data: others }, { data: myProps }] = await Promise.all([
    supabase.from('customers').select('id, name, email, phone').eq('id', customerId).maybeSingle(),
    supabase.from('customers').select('id, name, email, phone').neq('id', customerId),
    supabase.from('properties').select('id, norm_address').eq('customer_id', customerId),
  ])
  if (!me) throw new Error('Client not found.')

  const myEmail = norm(me.email)
  const myPhone = dig(me.phone)
  const myAddrs = new Set((myProps || []).map((p) => (p.norm_address || '').trim()).filter(Boolean))

  // customer id -> why they matched (first reason wins)
  const byKey = { email: new Map(), phone: new Map(), address: new Map() }
  for (const c of others || []) {
    if (myEmail && norm(c.email) && norm(c.email) === myEmail) byKey.email.set(c.id, c.name)
    else if (myPhone && dig(c.phone) && dig(c.phone) === myPhone) byKey.phone.set(c.id, c.name)
  }
  if (myAddrs.size) {
    const { data: theirProps } = await supabase
      .from('properties')
      .select('customer_id, norm_address')
      .not('customer_id', 'is', null)
      .in('norm_address', [...myAddrs].slice(0, 40))
    for (const p of theirProps || []) {
      if (p.customer_id === customerId || byKey.email.has(p.customer_id) || byKey.phone.has(p.customer_id)) continue
      if (!byKey.address.has(p.customer_id)) byKey.address.set(p.customer_id, null) // name filled below
    }
  }

  const matchIds = [...new Set([...byKey.email.keys(), ...byKey.phone.keys(), ...byKey.address.keys()])]
  const names = matchIds.length
    ? (await supabase.from('customers').select('id, name').in('id', matchIds)).data || []
    : []
  const nameOf = Object.fromEntries(names.map((n) => [n.id, n.name]))

  const ids = [customerId, ...matchIds].slice(0, 50)
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('id, number, status, issue_date, due_date, subtotal, total, tip_amount, sent_at, paid_at, created_at, customer_id, customers(name)')
    .in('customer_id', ids)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error

  return (invoices || []).map((inv) => {
    if (inv.customer_id === customerId) return inv
    const reason = byKey.email.has(inv.customer_id) ? 'email' : byKey.phone.has(inv.customer_id) ? 'phone' : 'address'
    return { ...inv, matchReason: reason, matchName: nameOf[inv.customer_id] || inv.customers?.name || '' }
  })
}

// ---- manual proof-of-service photos attached to an invoice ------------------
// Files live in the public `stop-photos` bucket under inv/<invoiceId>/ (no new
// bucket); the invoice_photos table tracks metadata. Photos with a stop_id
// render inside the matching line item; the rest render in the invoice's
// trailing photo grid.
const PHOTO_BUCKET = 'stop-photos'
const photoUrl = (path) => supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl

export async function loadInvoicePhotos(invoiceId) {
  const { data, error } = await supabase
    .from('invoice_photos')
    .select('id, stop_id, path, taken_on, note, created_by, created_at')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map((r) => ({ ...r, url: photoUrl(r.path) }))
}

export async function uploadInvoicePhoto(invoiceId, file, { stopId = null, takenOn = null, note = null, createdBy = null } = {}) {
  const ext = (file.name && file.name.split('.').pop()) || 'jpg'
  const path = `inv/${invoiceId}/${crypto.randomUUID()}.${ext.toLowerCase()}`
  const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(path, file, {
    cacheControl: '3600', contentType: file.type || 'image/jpeg', upsert: false,
  })
  if (upErr) throw upErr
  const { data, error } = await supabase
    .from('invoice_photos')
    .insert({ invoice_id: invoiceId, stop_id: stopId || null, path, taken_on: takenOn || null, note: note || null, created_by: createdBy || null })
    .select('id, stop_id, path, taken_on, note, created_by, created_at')
    .single()
  if (error) throw error
  return { ...data, url: photoUrl(data.path) }
}

export async function deleteInvoicePhoto(photo) {
  const { error } = await supabase.from('invoice_photos').delete().eq('id', photo.id)
  if (error) throw error
  // Only remove the stored file for photos WE uploaded (inv/ prefix) — rows
  // attached from an existing stop/property photo just borrow that path.
  if (String(photo.path || '').startsWith('inv/')) {
    try { await supabase.storage.from(PHOTO_BUCKET).remove([photo.path]) } catch (e) { /* row gone; object cleanup best-effort */ }
  }
}

// Reference an EXISTING photo (e.g. one the driver captured at the stop)
// on this invoice — no re-upload, just a metadata row pointing at the same
// storage object.
export async function attachExistingPhoto(invoiceId, { stopId = null, path, takenOn = null, createdBy = null }) {
  const { data, error } = await supabase
    .from('invoice_photos')
    .insert({ invoice_id: invoiceId, stop_id: stopId || null, path, taken_on: takenOn || null, created_by: createdBy || null })
    .select('id, stop_id, path, taken_on, note, created_by, created_at')
    .single()
  if (error) throw error
  return { ...data, url: photoUrl(data.path) }
}

// The client's service history for the Add-photos modal: their properties'
// route stops (visit date, service, address), newest first.
export async function loadClientServiceHistory(customerId, limit = 25) {
  const { data, error } = await supabase
    .from('route_stops')
    .select('id, service, properties!inner(address, name, service), routes(service_date, code)')
    .eq('properties.customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(120)
  if (error) throw error
  return (data || [])
    .filter((s) => s.routes?.service_date)
    .sort((a, b) => String(b.routes.service_date).localeCompare(String(a.routes.service_date)))
    .slice(0, limit)
    .map((s) => ({
      stopId: s.id,
      date: String(s.routes.service_date).slice(0, 10),
      service: s.service || s.properties?.service || '',
      address: s.properties?.address || s.properties?.name || '',
      route: s.routes?.code || null,
    }))
}

// Replace all line items for an invoice (simplest correct edit path).
async function writeLineItems(invoiceId, items) {
  const { error: delErr } = await supabase
    .from('invoice_line_items')
    .delete()
    .eq('invoice_id', invoiceId)
  if (delErr) throw delErr
  const rows = (items || [])
    .filter((it) => (it.title || '').trim() || (it.description || '').trim() || num(it.quantity) || num(it.unitPrice))
    .map((it, i) => ({
      invoice_id: invoiceId,
      title: (it.title || '').trim() || null,
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

// Mint a Run Merchant pay link (the in-portal Runner.js pay screen) for the
// invoice, store it, and mark sent.
export async function sendInvoiceLink(invoice) {
  if (!invoice.total || invoice.total < 0.5) {
    throw new Error('Invoice total must be at least $0.50 to create a payment link.')
  }
  const d = await invoicePaymentUrl(invoice.id)
  if (!d || !d.url) throw new Error('Could not create a payment link.')
  logActivity({ type: 'invoice_sent', summary: `Sent payment link for invoice ${invoice.number} (${money(invoice.total)})`, entityType: 'invoice', entityId: invoice.id })
  return d.url
}

// Text the customer their invoice: ensure a pay link exists, render the
// invoice SMS template from settings, send via the sms edge function, and
// mark the invoice sent. Mirrors the old app's purpose:"invoice" trigger.
export async function textInvoice(invoice, customMessage) {
  if (!invoice.customerPhone) throw new Error('This customer has no phone number on file.')

  // Reuse the stored pay link, or mint one (also marks the invoice sent).
  let payUrl = invoice.paymentUrl || invoice.stripePaymentUrl
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

// Email the customer their invoice: a full HTML invoice (line items, totals,
// terms) with a Pay Now button, sent server-side via SendGrid through the
// payments edge function. Marks the invoice sent.
export async function emailInvoice(invoice) {
  if (!invoice.customerEmail) throw new Error('This customer has no email on file.')
  const r = await emailInvoicePay(invoice.id)
  if (!r || !r.ok) throw new Error('Could not send the invoice email.')
  if (invoice.status === 'draft') {
    await setInvoiceStatus(invoice.id, 'sent', { sent_at: new Date().toISOString() })
  }
  logActivity({ type: 'invoice_emailed', summary: `Emailed invoice ${invoice.number} to ${invoice.customerEmail}`, entityType: 'invoice', entityId: invoice.id })
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
