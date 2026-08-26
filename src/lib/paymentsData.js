// Run Merchant (Run Payments) data layer — replaces stripeData.js for the
// customer-facing payment flow. All calls go through the `payments` edge
// function so Run Merchant credentials stay server-side.
import { supabase } from './supabaseClient.js'

async function call(body) {
  const { data, error } = await supabase.functions.invoke('payments', { body })
  if (error) throw error
  if (data && data.error) throw new Error(data.error)
  return data
}

// Merchant connection status for the Settings card.
export const paymentsStatus = () => call({ action: 'status' })

// Store merchant credentials (staff-only on the backend). Partial saves are
// fine — only fields with a non-empty value are written.
export const savePaymentsCredentials = (p) => call({ action: 'save_credentials', ...p })

// Request a 6-digit reveal code emailed to an allowlisted address.
export const revealRequest = (email) => call({ action: 'reveal_request', email })

// Verify the code; on success returns the plaintext credentials (one-shot).
export const revealVerify = (email, code) => call({ action: 'reveal_verify', email, code })

// Mint/store the portal pay link for an invoice (marks it 'sent' first time).
export const invoicePaymentUrl = (invoiceId) =>
  call({ action: 'payment_url', invoice_id: invoiceId, origin: window.location.origin })

// Email the customer a full HTML invoice with a Pay Now button (SendGrid,
// server-side). Mints the pay link if needed and marks the invoice 'sent'.
export const emailInvoice = (invoiceId) =>
  call({ action: 'email_invoice', invoice_id: invoiceId, origin: window.location.origin })

// Schedule an invoice send (sms/email/both) for a future Eastern-time
// moment; the automations runner delivers it within ~5 minutes of sendAt.
export const scheduleInvoiceSend = (invoiceId, channel, sendAtIso) =>
  call({ action: 'schedule_send', invoice_id: invoiceId, channel, send_at: sendAtIso })

export const listScheduledSends = (invoiceId) =>
  call({ action: 'scheduled_sends_list', invoice_id: invoiceId })

export const cancelScheduledSend = (id) =>
  call({ action: 'cancel_scheduled_send', id })

// Run a one-time charge against a tokenized card (from Runner.js). Optionally
// vault the card for autopay (save_card). Pass useSaved:true to charge the
// customer's card on file (vault) instead of a freshly tokenized card — used
// by the staff "Take payment" modal.
export const chargeInvoice = (p) =>
  call({ action: 'charge_invoice', invoice_id: p.invoiceId, account_token: p.accountToken, expiration: p.expiration, cvn: p.cvn, name: p.name, address: p.address, save_card: !!p.saveCard, use_saved: !!p.useSaved })
