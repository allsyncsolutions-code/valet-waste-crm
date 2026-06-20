// Stripe Connect helpers — all go through the `stripe` edge function so the
// platform secret key stays server-side.
import { supabase } from './supabaseClient.js'

async function call(body) {
  const { data, error } = await supabase.functions.invoke('stripe', { body })
  if (error) throw error
  if (data && data.error) throw new Error(data.error)
  return data
}

export const stripeStatus = () => call({ action: 'status' })
export const stripeOnboard = (origin) => call({ action: 'onboard', origin: origin || window.location.origin })
export const stripePaymentLink = (p) =>
  call({ action: 'payment_link', origin: window.location.origin, ...p })
