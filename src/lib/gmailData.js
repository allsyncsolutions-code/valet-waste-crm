// Gmail connection (Settings → Email) — the company Gmail staff reply to
// client requests from. All calls go through the gmail-oauth edge function
// with the signed-in staff member's JWT; secrets never touch the client.
import { supabase } from './supabaseClient.js'

async function call(body) {
  const { data, error } = await supabase.functions.invoke('gmail-oauth', { body })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

export const gmailStatus = () => call({ action: 'status' })
export const gmailSaveCredentials = (clientId, clientSecret) =>
  call({ action: 'save_credentials', client_id: clientId, client_secret: clientSecret })
export const gmailStartConnect = () =>
  call({ action: 'start', origin: window.location.origin })
export const gmailDisconnect = () => call({ action: 'disconnect' })
export const gmailTestSend = (to) =>
  call({
    action: 'send',
    to,
    subject: '✓ Gmail connected — Valet Waste',
    text: 'This is a test send from the Valet Waste CRM. If you got this, replying to client requests by email works.',
  })
