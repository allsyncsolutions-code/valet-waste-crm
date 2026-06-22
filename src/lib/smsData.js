// SMS (RingCentral + Telnyx fallback) helpers. Everything goes through the
// `sms` edge function so the Client Secret / JWT never reach the browser.
import { supabase } from './supabaseClient.js'

async function call(body) {
  const { data, error } = await supabase.functions.invoke('sms', { body })
  if (error) throw error
  if (data && data.error) throw new Error(data.error)
  return data
}

// Returns non-secret config + secret-presence flags + the webhook URL to
// register in RingCentral. Never returns the secret values themselves.
export const getSmsConfig = () => call({ action: 'get_config' })

// `config` carries the form fields. Secret fields (rc_client_secret, rc_jwt)
// are only written when non-empty — blank means "keep the saved value".
export const saveSmsConfig = (config) => call({ action: 'save_config', config })

// Send one SMS. `to` is any phone format; the function normalizes to E.164.
// opts: { customerId, purpose, sentBy } — purpose is logged for the Activity view.
export const sendSms = (to, body, opts = {}) =>
  call({ action: 'send', to, body, customerId: opts.customerId, purpose: opts.purpose, sentBy: opts.sentBy })

// Fill {token} placeholders in a message template.
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m))
}

// Fire a test text to confirm the setup works end to end.
export const sendTestSms = (to) => call({ action: 'test', to })

// Inbound-reply webhook subscription lifecycle (RingCentral push subscriptions
// expire, so we create + auto-renew them via the API instead of registering by
// hand). `renew` is what the scheduled cron calls.
export const listSmsSubscriptions = () => call({ action: 'list_subscriptions' })
export const ensureSmsSubscription = () => call({ action: 'ensure_subscription' })
export const renewSmsSubscriptions = () => call({ action: 'renew_subscriptions' })
