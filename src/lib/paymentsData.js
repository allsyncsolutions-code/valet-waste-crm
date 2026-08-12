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

// Store merchant credentials (staff-only on the backend).
export const savePaymentsCredentials = (p) => call({ action: 'save_credentials', ...p })

// Mint/store the portal pay link for an invoice (marks it 'sent' first time).
export const invoicePaymentUrl = (invoiceId) =>
  call({ action: 'payment_url', invoice_id: invoiceId, origin: window.location.origin })

// Run a one-time charge against a tokenized card (from Runner.js). Optionally
// vault the card for autopay (save_card).
export const chargeInvoice = (p) =>
  call({ action: 'charge_invoice', invoice_id: p.invoiceId, account_token: p.accountToken, expiration: p.expiration, cvn: p.cvn, name: p.name, address: p.address, save_card: !!p.saveCard })
