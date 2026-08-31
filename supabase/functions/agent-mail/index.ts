// Agent mail — the return channel of the AGENTS.md owner-approval workflow.
//
// Coding agents (Claude Code / ZCode / Kimi) email blocking questions to
// dev-agents@allsynccrm.com. This function connects the company Outlook
// mailbox (Microsoft Graph — mirror of gmail-oauth's Google flow), and a
// 2-minute cron poll:
//   • new [AGENT-QUESTION] email  → stored in agent_questions + staff push
//   • David's reply starting APPROVE:/REJECT/CLARIFY → validated, matched by
//     Question-ID / conversation, posted to the linked GitHub PR or issue.
//     Replies are matched from BOTH the inbox and Sent Items — dev-agents@ is
//     an alias on David's mailbox, so a plain Reply goes to the agent's From
//     address and only ever shows up in Sent.
//   • informal replies ("looks good") → bounced back, never forwarded
//
// GET  (no action)  → OAuth callback: Microsoft redirects here with ?code&state
// POST action=status                  → { configured, connected, email, … }
// POST action=save_credentials(staff) → store client id/secret/tenant/GitHub token
// POST action=start           (staff) → Microsoft consent URL (stores CSRF state)
// POST action=disconnect      (staff) → forget the connection
// POST action=poll     (cron/staff)   → scan the mailbox (the cron tick)
//
// Setup (one-time, David): Entra app registration ("Chronos") → Authentication →
// add Web redirect URI = this function's URL (shown on the Settings card) →
// Certificates & secrets → new client secret. Delegated Graph permissions
// needed: Mail.ReadWrite, Mail.Send (already granted on Chronos).
//
// Deploy: supabase functions deploy agent-mail --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/agent-mail`
const GRAPH = "https://graph.microsoft.com/v1.0"
const AUTH_SCOPES =
  "offline_access openid email profile https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send"

// Decisions may only ever be posted to these repos.
const REPO_ALLOWLIST = /^allsyncsolutions-code\/(valet-waste-crm|valet-waste-mobile)$/

const ALLOWED_ORIGINS = [
  Deno.env.get("PORTAL_ORIGIN") || "https://valet-waste-crm.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
]

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders })
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}
async function sbPatch(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`PATCH ${path}: ${r.status} ${await r.text()}`)
}
async function sbPost(path: string, body: unknown, prefer = "return=minimal") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: prefer },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`)
  return prefer.includes("representation") ? await r.json() : null
}

async function settings() {
  const rows = await sbGet(
    `app_settings?id=eq.1&select=company_name,agentmail_client_id,agentmail_client_secret,agentmail_tenant,agentmail_refresh_token,agentmail_email,agentmail_connected_by,agentmail_connected_at,agentmail_access_token,agentmail_token_expires_at,agentmail_oauth_state,agentmail_github_token,agentmail_last_poll_at`,
  )
  return rows[0] || {}
}

// Same auth shape as the other admin functions: service key, the internal
// cron token, or a signed-in admin/staff user.
async function auth(req: Request): Promise<{ ok: true; email?: string } | { ok: false; why: string }> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
  if (!token) return { ok: false, why: "Sign in required." }
  if (token === SERVICE_KEY) return { ok: true }
  const internal = await sbGet(`internal_secrets?id=eq.1&select=cron_token`).catch(() => [])
  if (internal?.[0]?.cron_token && token === internal[0].cron_token) return { ok: true }
  const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!ures.ok) return { ok: false, why: "Sign in required." }
  const u = await ures.json()
  if (!u?.id) return { ok: false, why: "Sign in required." }
  const prof = await sbGet(`profiles?id=eq.${u.id}&select=role,full_name,email`)
  if (!["admin", "staff"].includes(prof?.[0]?.role)) return { ok: false, why: "Staff only." }
  return { ok: true, email: prof[0]?.full_name || prof[0]?.email || u.email || "Staff" }
}

function tenant(s: Record<string, any>) {
  return (s.agentmail_tenant || "").trim() || "allsynccrm.com"
}

// Mint a fresh Graph access token. Microsoft ROTATES refresh tokens — always
// store the new one when it hands one back.
async function accessToken(s: Record<string, any>): Promise<string> {
  if (s.agentmail_access_token && s.agentmail_token_expires_at && new Date(s.agentmail_token_expires_at).getTime() - Date.now() > 60 * 1000) {
    return s.agentmail_access_token
  }
  if (!s.agentmail_refresh_token || !s.agentmail_client_id || !s.agentmail_client_secret) {
    throw new Error("Outlook isn't connected — connect it in Settings → Agent approvals.")
  }
  const r = await fetch(`https://login.microsoftonline.com/${tenant(s)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.agentmail_client_id,
      client_secret: s.agentmail_client_secret,
      refresh_token: s.agentmail_refresh_token,
      grant_type: "refresh_token",
      scope: AUTH_SCOPES,
    }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    const hint = d?.error === "invalid_grant"
      ? "Outlook was disconnected (permission expired) — reconnect it in Settings → Agent approvals."
      : `Microsoft token refresh failed: ${d?.error_description || d?.error || r.status}`
    throw new Error(hint)
  }
  await sbPatch(`app_settings?id=eq.1`, {
    agentmail_access_token: d.access_token,
    agentmail_token_expires_at: new Date(Date.now() + Number(d.expires_in || 3600) * 1000).toISOString(),
    ...(d.refresh_token ? { agentmail_refresh_token: d.refresh_token } : {}),
  }).catch(() => {})
  return d.access_token as string
}

function consentUrl(s: Record<string, any>, state: string) {
  const p = new URLSearchParams({
    client_id: s.agentmail_client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    response_mode: "query",
    scope: AUTH_SCOPES,
    prompt: "select_account",
    state,
  })
  return `https://login.microsoftonline.com/${tenant(s)}/oauth2/v2.0/authorize?${p}`
}

// ---------------------------------------------------------------------------
// Parsing helpers

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function bodyText(m: any): string {
  const raw = String(m?.body?.content || "")
  return m?.body?.contentType === "html" ? htmlToText(raw) : raw.replace(/\r/g, "").trim()
}

// Header-style field out of an AGENT-QUESTION v1 body ("Branch: main").
function field(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, "mi"))
  return m ? m[1].trim() : null
}

// The part of a reply David actually typed — cut at the first quoted-mail marker.
function unquoted(text: string): string {
  const markers = [
    /^\s*From:\s.+$/m,                    // Outlook desktop/web quote header
    /^\s*On .{6,120} wrote:\s*$/m,        // "On Mon, Aug 31 … wrote:"
    /^\s*-{3,}\s*Original Message\s*-{3,}/mi,
    /^\s*_{10,}\s*$/m,                    // Outlook divider
    /^\s*>/m,                             // plain-text quoting
  ]
  let cut = text.length
  for (const re of markers) {
    const m = text.match(re)
    if (m && m.index !== undefined && m.index < cut) cut = m.index
  }
  return text.slice(0, cut).trim()
}

function parseDecision(text: string): { decision: string; body: string } | null {
  const t = unquoted(text)
  const first = (t.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "")
  const m = first.match(/^(APPROVE:|REJECT\b|CLARIFY\b)/i)
  if (!m) return null
  const word = m[1].toUpperCase().replace(/[^A-Z]/g, "")
  return { decision: word, body: t }
}

const QID_RE = /\baq_[A-Za-z0-9][A-Za-z0-9_-]*\b/

// ---------------------------------------------------------------------------
// Outbound helpers

async function sendStaffPush(title: string, body: string): Promise<number> {
  const tokens = await sbGet(`push_tokens?profile_id=not.is.null&select=token&limit=50`).catch(() => [])
  let sent = 0
  for (const t of tokens) {
    try {
      const r = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: t.token, title, body, sound: "default" }),
      })
      const d = await r.json().catch(() => ({} as any))
      const rec: any = Array.isArray(d?.data) ? d?.data?.[0] : d?.data
      if (r.ok && rec?.status === "ok") sent++
    } catch (_e) { /* best effort per token */ }
  }
  return sent
}

async function replyToMessage(token: string, messageId: string, comment: string) {
  const r = await fetch(`${GRAPH}/me/messages/${messageId}/reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ comment }),
  })
  if (!r.ok && r.status !== 202) throw new Error(`Graph reply failed: ${r.status} ${await r.text()}`)
}

async function markRead(token: string, messageId: string) {
  await fetch(`${GRAPH}/me/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ isRead: true }),
  }).catch(() => {})
}

async function postGithubComment(s: Record<string, any>, q: any, decision: string, body: string) {
  const ghToken = (s.agentmail_github_token || "").trim()
  if (!ghToken) throw new Error("No GitHub token saved — paste one in Settings → Agent approvals.")
  const repo = String(q.repo || "").trim()
  if (!REPO_ALLOWLIST.test(repo)) throw new Error(`Repo "${repo || "(none)"}" isn't in the allowlist.`)
  const num = q.pr_number || q.issue_number
  if (!num) throw new Error("The question has no PR or issue number to post to.")
  const md =
    `## 🔑 Owner decision — \`${q.question_id || "no-id"}\`\n\n` +
    "```text\n" + body.replace(/```/g, "ʼʼʼ") + "\n```\n\n" +
    `---\n_${decision} received by email from the owner and posted automatically by agent-mail (${new Date().toISOString()})._`
  const r = await fetch(`https://api.github.com/repos/${repo}/issues/${num}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "valet-waste-agent-mail",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: md }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${d?.message || "comment failed"}`)
  return String(d.html_url || "")
}

// ---------------------------------------------------------------------------
// The poll — heart of the return channel.

async function poll(s: Record<string, any>): Promise<Record<string, unknown>> {
  if (!s.agentmail_refresh_token) return { ok: true, skipped: "Outlook not connected" }
  const token = await accessToken(s)
  const overlapMs = 5 * 60 * 1000
  const since = s.agentmail_last_poll_at
    ? new Date(new Date(s.agentmail_last_poll_at).getTime() - overlapMs)
    : new Date(Date.now() - 24 * 3600 * 1000)
  const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)
  const select = "id,subject,from,toRecipients,receivedDateTime,conversationId,internetMessageId,isRead,body"
  const r = await fetch(
    `${GRAPH}/me/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=50&$select=${select}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Graph list failed: ${d?.error?.message || r.status}`)
  const messages: any[] = d?.value || []

  let questions = 0, decisions = 0, bounces = 0
  const notes: string[] = []

  for (const m of messages) {
    const msgKey = String(m.internetMessageId || m.id)
    const seen = await sbGet(`agent_mail_seen?message_id=eq.${encodeURIComponent(msgKey)}&select=message_id`).catch(() => [])
    if (seen.length) continue
    const subject = String(m.subject || "")
    const text = bodyText(m)
    const fromEmail = String(m?.from?.emailAddress?.address || "").toLowerCase()
    const isQuestion = /\[AGENT-QUESTION\]/i.test(subject) && !/^\s*re\s*:/i.test(subject) && /AGENT-QUESTION v1/i.test(text)

    if (isQuestion) {
      const qid = (text.match(QID_RE) || [null])[0] || `aq_${(m.internetMessageId || m.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`
      const prFromSubject = subject.match(/GitHub PR #(\d+)/i)?.[1]
      const issueFromSubject = subject.match(/GitHub Issue #(\d+)/i)?.[1]
      const pr = field(text, "Pull-Request") || prFromSubject
      const issue = field(text, "Issue") || issueFromSubject
      try {
        await sbPost(`agent_questions`, {
          question_id: qid,
          project: field(text, "Project"),
          repo: field(text, "Repository"),
          branch: field(text, "Branch"),
          source: field(text, "Source"),
          return_channel: field(text, "Return-Channel") || "github-pr-comment",
          pr_number: pr && /^\d+$/.test(pr) ? Number(pr) : null,
          issue_number: issue && /^\d+$/.test(issue) ? Number(issue) : null,
          subject,
          body: text.slice(0, 20000),
          from_email: fromEmail,
          message_id: msgKey,
          conversation_id: m.conversationId || null,
          received_at: m.receivedDateTime || new Date().toISOString(),
        })
        questions++
        const title = subject.replace(/\[[^\]]*\]/g, "").trim().slice(0, 80) || qid
        await sendStaffPush(
          `🤖 Agent question — ${field(text, "Source") || "coding agent"}`,
          `${title}\nReply to the email starting APPROVE:, REJECT or CLARIFY.`,
        )
        await sbPost(`activity_log`, {
          type: "agent_question",
          actor: field(text, "Source") || "agent",
          summary: `Blocking question ${qid}: ${title}`,
        }).catch(() => {})
      } catch (e) {
        notes.push(`question ${qid}: ${String(e).slice(0, 120)}`)
      }
      await markRead(token, m.id)
    } else {
      // A decision reply? Match by Question-ID in the text, else conversation.
      let q: any = null
      const qid = (text.match(QID_RE) || [null])[0]
      if (qid) {
        const rows = await sbGet(`agent_questions?question_id=eq.${encodeURIComponent(qid)}&select=*`).catch(() => [])
        q = rows[0] || null
      }
      if (!q && m.conversationId) {
        const rows = await sbGet(
          `agent_questions?conversation_id=eq.${encodeURIComponent(m.conversationId)}&status=in.(pending,error)&order=created_at.desc&limit=1&select=*`,
        ).catch(() => [])
        q = rows[0] || null
      }
      if (q && ["pending", "error"].includes(q.status)) {
        const ours = fromEmail.endsWith("@allsynccrm.com") || fromEmail === String(s.agentmail_email || "").toLowerCase()
        const parsed = ours ? parseDecision(text) : null
        if (parsed) {
          const now = new Date().toISOString()
          try {
            const url = await postGithubComment(s, q, parsed.decision, parsed.body)
            await sbPatch(`agent_questions?id=eq.${q.id}`, {
              status: "posted", decision: parsed.decision, decision_body: parsed.body,
              decision_message_id: msgKey, answered_at: now, posted_at: now,
              github_comment_url: url, error: null,
            })
            decisions++
            const target = q.pr_number ? `PR #${q.pr_number}` : `issue #${q.issue_number}`
            await sendStaffPush(`✅ ${parsed.decision} posted`, `${q.question_id} → ${q.repo} ${target}`)
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e)
            await sbPatch(`agent_questions?id=eq.${q.id}`, {
              status: "answered", decision: parsed.decision, decision_body: parsed.body,
              decision_message_id: msgKey, answered_at: now, error: why,
            }).catch(() => {})
            await sendStaffPush(`⚠️ Decision saved but not posted`, `${q.question_id}: ${why.slice(0, 120)}`)
            notes.push(`post ${q.question_id}: ${why.slice(0, 120)}`)
          }
          await markRead(token, m.id)
        } else if (ours) {
          bounces++
          await replyToMessage(token, m.id,
            `⚠️ This reply was NOT delivered to the agent. Decisions must start with APPROVE:, REJECT or CLARIFY on the first line (per AGENTS.md). Question ${q.question_id} is still waiting.`,
          ).catch(() => {})
          await markRead(token, m.id)
        }
        // replies from anyone else: leave untouched
      }
      // unrelated mail: never touched, never marked read
    }
    await sbPost(`agent_mail_seen`, { message_id: msgKey }).catch(() => {})
  }

  // ---- Sent Items: a plain Reply to an agent question goes to the agent's
  // From address (dev-agents@ is an alias), so David's decisions usually only
  // appear in Sent — match them there too (covers Outlook and Perplexity
  // sending through his mailbox).
  const r2 = await fetch(
    `${GRAPH}/me/mailFolders/sentitems/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=50&$select=${select}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const d2 = await r2.json().catch(() => ({}))
  const sentMessages: any[] = r2.ok ? (d2?.value || []) : []
  for (const m of sentMessages) {
    const msgKey = String(m.internetMessageId || m.id)
    const seen = await sbGet(`agent_mail_seen?message_id=eq.${encodeURIComponent(msgKey)}&select=message_id`).catch(() => [])
    if (seen.length) continue
    const subject = String(m.subject || "")
    // A question email that originated from this mailbox lives in Sent too —
    // never treat the question itself as a reply.
    if (/\[AGENT-QUESTION\]/i.test(subject) && !/^\s*re\s*:/i.test(subject)) {
      await sbPost(`agent_mail_seen`, { message_id: msgKey }).catch(() => {})
      continue
    }
    const text = bodyText(m)
    let q: any = null
    const qid = (text.match(QID_RE) || [null])[0]
    if (qid) {
      const rows = await sbGet(`agent_questions?question_id=eq.${encodeURIComponent(qid)}&select=*`).catch(() => [])
      q = rows[0] || null
    }
    if (!q && m.conversationId) {
      const rows = await sbGet(
        `agent_questions?conversation_id=eq.${encodeURIComponent(m.conversationId)}&status=in.(pending,error)&order=created_at.desc&limit=1&select=*`,
      ).catch(() => [])
      q = rows[0] || null
    }
    if (q && ["pending", "error"].includes(q.status) && msgKey !== q.message_id) {
      const parsed = parseDecision(text)
      if (parsed) {
        const now = new Date().toISOString()
        try {
          const url = await postGithubComment(s, q, parsed.decision, parsed.body)
          await sbPatch(`agent_questions?id=eq.${q.id}`, {
            status: "posted", decision: parsed.decision, decision_body: parsed.body,
            decision_message_id: msgKey, answered_at: now, posted_at: now,
            github_comment_url: url, error: null,
          })
          decisions++
          const target = q.pr_number ? `PR #${q.pr_number}` : `issue #${q.issue_number}`
          await sendStaffPush(`✅ ${parsed.decision} posted`, `${q.question_id} → ${q.repo} ${target}`)
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e)
          await sbPatch(`agent_questions?id=eq.${q.id}`, {
            status: "answered", decision: parsed.decision, decision_body: parsed.body,
            decision_message_id: msgKey, answered_at: now, error: why,
          }).catch(() => {})
          await sendStaffPush(`⚠️ Decision saved but not posted`, `${q.question_id}: ${why.slice(0, 120)}`)
          notes.push(`post ${q.question_id}: ${why.slice(0, 120)}`)
        }
      } else {
        bounces++
        await sendStaffPush(
          `⚠️ Reply not delivered to agent`,
          `Your reply to ${q.question_id} must start with APPROVE:, REJECT or CLARIFY on the first line — it's still waiting.`,
        )
      }
      await sbPost(`agent_mail_seen`, { message_id: msgKey }).catch(() => {})
    } else if (q) {
      await sbPost(`agent_mail_seen`, { message_id: msgKey }).catch(() => {})
    }
    // sent mail with no matching question: skipped, not recorded
  }

  await sbPatch(`app_settings?id=eq.1`, { agentmail_last_poll_at: new Date().toISOString() }).catch(() => {})
  // Prune the dedupe table (>14 days old).
  await fetch(`${SUPABASE_URL}/rest/v1/agent_mail_seen?seen_at=lt.${new Date(Date.now() - 14 * 86400e3).toISOString()}`, {
    method: "DELETE", headers: restHeaders,
  }).catch(() => {})

  return { ok: true, scanned: messages.length + sentMessages.length, questions, decisions, bounces, ...(notes.length ? { notes } : {}) }
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const url = new URL(req.url)

  // ---- GET = OAuth callback (Microsoft redirects here) ----------------------
  if (req.method === "GET") {
    const back = (q: string) => new Response(null, { status: 302, headers: { Location: q } })
    const s = await settings().catch(() => ({} as any))
    const origin = ALLOWED_ORIGINS.includes(String(s.agentmail_oauth_state?.origin || "")) ? s.agentmail_oauth_state.origin : ALLOWED_ORIGINS[0]
    const fail = (msg: string) => back(`${origin}/?agentmail_error=${encodeURIComponent(msg)}`)

    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const saved = s.agentmail_oauth_state
    if (url.searchParams.get("error")) return fail(String(url.searchParams.get("error_description") || url.searchParams.get("error")))
    if (!code || !state || !saved || saved.token !== state) return fail("The connect link expired — try Connect again.")
    if (Number(saved.exp) < Date.now()) return fail("The connect link expired — try Connect again.")

    try {
      const r = await fetch(`https://login.microsoftonline.com/${tenant(s)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: s.agentmail_client_id,
          client_secret: s.agentmail_client_secret,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
          scope: AUTH_SCOPES,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return fail(d?.error_description || d?.error || `Microsoft token exchange failed (${r.status})`)

      let email = s.agentmail_email || ""
      try {
        const payload = JSON.parse(atob((String(d.id_token).split(".")[1] || "").replace(/-/g, "+").replace(/_/g, "/")))
        if (payload?.email || payload?.preferred_username) email = String(payload.email || payload.preferred_username)
      } catch (_e) { /* keep previous */ }

      await sbPatch(`app_settings?id=eq.1`, {
        agentmail_refresh_token: d.refresh_token || s.agentmail_refresh_token,
        agentmail_email: email || null,
        agentmail_connected_at: new Date().toISOString(),
        agentmail_connected_by: saved.actor || "Staff",
        agentmail_access_token: d.access_token || null,
        agentmail_token_expires_at: new Date(Date.now() + Number(d.expires_in || 3600) * 1000).toISOString(),
        agentmail_oauth_state: null,
      })
      return back(`${origin}/?agentmail_connected=1`)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }

  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const body = req.method === "POST" ? await req.json() : {}
    const action = String(body?.action || "")

    if (action === "status") {
      const s = await settings()
      const pending = await sbGet(`agent_questions?status=eq.pending&select=id`).catch(() => [])
      return json({
        configured: !!(s.agentmail_client_id && s.agentmail_client_secret),
        connected: !!s.agentmail_refresh_token,
        email: s.agentmail_refresh_token ? s.agentmail_email || "(connected)" : null,
        connected_at: s.agentmail_connected_at || null,
        github_token_set: !!s.agentmail_github_token,
        last_poll_at: s.agentmail_last_poll_at || null,
        pending: pending.length,
        redirect_uri: REDIRECT_URI,
      })
    }

    if (action === "save_credentials") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      const patch: Record<string, unknown> = {}
      if (typeof body.client_id === "string" && body.client_id.trim()) patch.agentmail_client_id = body.client_id.trim()
      if (typeof body.client_secret === "string" && body.client_secret.trim()) patch.agentmail_client_secret = body.client_secret.trim()
      if (typeof body.tenant === "string" && body.tenant.trim()) patch.agentmail_tenant = body.tenant.trim()
      if (typeof body.github_token === "string" && body.github_token.trim()) patch.agentmail_github_token = body.github_token.trim()
      if (!Object.keys(patch).length) return json({ error: "Enter something to save." }, 400)
      // New OAuth credentials invalidate any existing connection (GitHub token doesn't).
      if (patch.agentmail_client_id || patch.agentmail_client_secret) {
        patch.agentmail_refresh_token = null
        patch.agentmail_email = null
        patch.agentmail_connected_at = null
        patch.agentmail_access_token = null
        patch.agentmail_token_expires_at = null
      }
      await sbPatch(`app_settings?id=eq.1`, patch)
      return json({ ok: true })
    }

    if (action === "start") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      const s = await settings()
      if (!s.agentmail_client_id || !s.agentmail_client_secret) {
        return json({ error: "Paste the Entra Client ID and Secret first (instructions above)." }, 400)
      }
      const origin = ALLOWED_ORIGINS.includes(String(body?.origin || "")) ? body.origin : ALLOWED_ORIGINS[0]
      const state = {
        token: crypto.randomUUID(),
        origin,
        actor: a.email || "Staff",
        exp: Date.now() + 10 * 60000,
      }
      await sbPatch(`app_settings?id=eq.1`, { agentmail_oauth_state: state })
      return json({ ok: true, url: consentUrl(s, state.token) })
    }

    if (action === "disconnect") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      await sbPatch(`app_settings?id=eq.1`, {
        agentmail_refresh_token: null,
        agentmail_email: null,
        agentmail_connected_at: null,
        agentmail_connected_by: null,
        agentmail_access_token: null,
        agentmail_token_expires_at: null,
        agentmail_oauth_state: null,
      })
      return json({ ok: true })
    }

    if (action === "poll") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      const s = await settings()
      return json(await poll(s))
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
