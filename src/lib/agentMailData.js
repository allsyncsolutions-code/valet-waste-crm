// Agent approvals (Settings → Agent approvals) — the Outlook return channel
// for coding-agent blocking questions (AGENTS.md workflow). All calls go
// through the agent-mail edge function with the signed-in staff member's JWT;
// secrets never touch the client.
import { supabase } from './supabaseClient.js'

async function call(body) {
  const { data, error } = await supabase.functions.invoke('agent-mail', { body })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

export const agentMailStatus = () => call({ action: 'status' })
export const agentMailSaveCredentials = (fields) =>
  call({ action: 'save_credentials', ...fields })
export const agentMailStartConnect = () =>
  call({ action: 'start', origin: window.location.origin })
export const agentMailDisconnect = () => call({ action: 'disconnect' })
export const agentMailPollNow = () => call({ action: 'poll' })

// Last few questions for the Settings card (RLS: staff read).
export async function agentQuestionsRecent(limit = 5) {
  const { data, error } = await supabase
    .from('agent_questions')
    .select('id,question_id,source,repo,pr_number,issue_number,status,decision,subject,created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}
