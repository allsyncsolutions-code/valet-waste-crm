// Platform (SaaS) billing helpers — the CRM's OWN $250/mo subscription.
// Distinct from stripeData.js (Stripe Connect, which charges the business's
// customers). All calls go through the `platform-billing` edge function so the
// platform secret key stays server-side.
import { supabase } from './supabaseClient.js'

async function call(body) {
  const { data, error } = await supabase.functions.invoke('platform-billing', { body })
  if (error) throw error
  if (data && data.error) throw new Error(data.error)
  return data
}

export const platformBillingStatus = () => call({ action: 'status' })
export const platformBillingCheckout = () =>
  call({ action: 'checkout', origin: window.location.origin })
export const platformBillingPortal = () =>
  call({ action: 'portal', origin: window.location.origin })
