// Gmail OAuth — connects the company Gmail (Settings → Email) so staff can
// reply to client portal requests by email straight from the CRM. Sends go
// through the Gmail API as the connected mailbox (so they thread and land in
// its Sent folder), using only the gmail.send scope.
//
// GET  (no action)  → OAuth callback: Google redirects here with ?code&state;
//                     exchanges the code, stores the refresh token, bounces
//                     the browser back to the app with ?gmail_connected=1.
// POST action=start           (staff) → Google consent URL (stores CSRF state)
// POST action=status                  → { configured, connected, email, … }
// POST action=save_credentials(staff) → store client id/secret
// POST action=disconnect       (staff) → forget the connection
// POST action=send             (staff) → send an email via Gmail
//
// Setup (one-time, David): Google Cloud console → create OAuth Client ID
// (Web application) → authorized redirect URI = this function's URL — shown
// on the Settings card. Paste the Client ID + Secret there, then Connect.
//
// Deploy: supabase functions deploy gmail-oauth --no-verify-jwt

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
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-oauth`
const AUTH_SCOPES = "https://www.googleapis.com/auth/gmail.send openid email"

// Where the browser may land after connecting (staff web app origins).
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

async function settings() {
  const rows = await sbGet(
    `app_settings?id=eq.1&select=company_name,gmail_client_id,gmail_client_secret,gmail_refresh_token,gmail_email,gmail_connected_by,gmail_connected_at,gmail_access_token,gmail_token_expires_at,gmail_oauth_state`,
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

// base64url of a UTF-8 string (chunked — spread on long strings overflows).
function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Mint a fresh access token (cached in app_settings ~1h).
async function accessToken(s: Record<string, any>): Promise<string> {
  if (s.gmail_access_token && s.gmail_token_expires_at && new Date(s.gmail_token_expires_at).getTime() - Date.now() > 60 * 1000) {
    return s.gmail_access_token
  }
  if (!s.gmail_refresh_token || !s.gmail_client_id || !s.gmail_client_secret) {
    throw new Error("Gmail isn't connected — connect it in Settings → Email.")
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.gmail_client_id,
      client_secret: s.gmail_client_secret,
      refresh_token: s.gmail_refresh_token,
      grant_type: "refresh_token",
    }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    const hint = d?.error === "invalid_grant"
      ? "Gmail was disconnected (permission expired) — reconnect it in Settings → Email."
      : `Gmail token refresh failed: ${d?.error_description || d?.error || r.status}`
    throw new Error(hint)
  }
  await sbPatch(`app_settings?id=eq.1`, {
    gmail_access_token: d.access_token,
    gmail_token_expires_at: new Date(Date.now() + Number(d.expires_in || 3600) * 1000).toISOString(),
  }).catch(() => {})
  return d.access_token as string
}

// Send via the Gmail API as the connected mailbox. `text` is the final body
// (the caller composes it); stamps portal_requests.replied_at/by and writes an
// activity-log line when portal_request_id is passed.
async function sendViaGmail(s: Record<string, any>, opts: {
  to: string
  subject: string
  text: string
  actor: string
  portalRequestId?: string
  customerId?: string
  customerName?: string
}) {
  const token = await accessToken(s)
  const company = s.company_name || "Valet Waste FL"
  const mime = [
    `From: ${company} <${s.gmail_email}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject.replace(/[\r\n]+/g, " ")}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    opts.text,
  ].join("\r\n")
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64url(mime) }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    throw new Error(`Gmail send failed: ${d?.error?.message || r.status}`)
  }
  const now = new Date().toISOString()
  if (opts.portalRequestId) {
    await sbPatch(`portal_requests?id=eq.${opts.portalRequestId}`, { replied_at: now, replied_by: opts.actor }).catch(() => {})
  }
  if (opts.customerId || opts.portalRequestId) {
    await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        type: "request_replied",
        actor: opts.actor,
        summary: `Emailed ${opts.customerName || opts.to} re: ${opts.subject}`,
        entity_type: "customer",
        entity_id: opts.customerId || null,
      }),
    }).catch(() => {})
  }
  return d.id as string
}

function consentUrl(s: Record<string, any>, state: string) {
  const p = new URLSearchParams({
    client_id: s.gmail_client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: AUTH_SCOPES,
    access_type: "offline",
    prompt: "consent", // always hand back a refresh token
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const url = new URL(req.url)

  // ---- GET = OAuth callback (Google redirects here) -------------------------
  if (req.method === "GET") {
    const back = (q: string) => new Response(null, { status: 302, headers: { Location: q } })
    const s = await settings().catch(() => ({} as any))
    const origin = ALLOWED_ORIGINS.includes(String(s.gmail_oauth_state?.origin || "")) ? s.gmail_oauth_state.origin : ALLOWED_ORIGINS[0]
    const fail = (msg: string) => back(`${origin}/?gmail_error=${encodeURIComponent(msg)}`)

    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const saved = s.gmail_oauth_state
    if (url.searchParams.get("error")) return fail(String(url.searchParams.get("error")))
    if (!code || !state || !saved || saved.token !== state) return fail("The connect link expired — try Connect again.")
    if (Number(saved.exp) < Date.now()) return fail("The connect link expired — try Connect again.")

    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: s.gmail_client_id,
          client_secret: s.gmail_client_secret,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return fail(d?.error_description || d?.error || `Google token exchange failed (${r.status})`)

      // The connected address rides in the id_token (openid email scope).
      let email = s.gmail_email || ""
      try {
        const payload = JSON.parse(atob((String(d.id_token).split(".")[1] || "").replace(/-/g, "+").replace(/_/g, "/")))
        if (payload?.email) email = String(payload.email)
      } catch (_e) { /* keep previous */ }

      await sbPatch(`app_settings?id=eq.1`, {
        gmail_refresh_token: d.refresh_token || s.gmail_refresh_token,
        gmail_email: email || null,
        gmail_connected_at: new Date().toISOString(),
        gmail_connected_by: saved.actor || "Staff",
        gmail_access_token: d.access_token || null,
        gmail_token_expires_at: new Date(Date.now() + Number(d.expires_in || 3600) * 1000).toISOString(),
        gmail_oauth_state: null,
      })
      return back(`${origin}/?gmail_connected=1`)
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
      return json({
        configured: !!(s.gmail_client_id && s.gmail_client_secret),
        connected: !!s.gmail_refresh_token,
        email: s.gmail_refresh_token ? s.gmail_email || "(connected)" : null,
        connected_at: s.gmail_connected_at || null,
        redirect_uri: REDIRECT_URI,
      })
    }

    if (action === "save_credentials") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      const patch: Record<string, unknown> = {}
      if (typeof body.client_id === "string" && body.client_id.trim()) patch.gmail_client_id = body.client_id.trim()
      if (typeof body.client_secret === "string" && body.client_secret.trim()) patch.gmail_client_secret = body.client_secret.trim()
      if (!Object.keys(patch).length) return json({ error: "Enter a Client ID or Secret to save." }, 400)
      // New credentials invalidate any existing connection.
      patch.gmail_refresh_token = null
      patch.gmail_email = null
      patch.gmail_connected_at = null
      patch.gmail_access_token = null
      patch.gmail_token_expires_at = null
      await sbPatch(`app_settings?id=eq.1`, patch)
      return json({ ok: true })
    }

    if (action === "start") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      const s = await settings()
      if (!s.gmail_client_id || !s.gmail_client_secret) {
        return json({ error: "Paste the Google Client ID and Secret first (instructions above)." }, 400)
      }
      const origin = ALLOWED_ORIGINS.includes(String(body?.origin || "")) ? body.origin : ALLOWED_ORIGINS[0]
      const state = {
        token: crypto.randomUUID(),
        origin,
        actor: a.email || "Staff",
        exp: Date.now() + 10 * 60000,
      }
      await sbPatch(`app_settings?id=eq.1`, { gmail_oauth_state: state })
      return json({ ok: true, url: consentUrl(s, state.token) })
    }

    if (action === "disconnect") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      await sbPatch(`app_settings?id=eq.1`, {
        gmail_refresh_token: null,
        gmail_email: null,
        gmail_connected_at: null,
        gmail_connected_by: null,
        gmail_access_token: null,
        gmail_token_expires_at: null,
        gmail_oauth_state: null,
      })
      return json({ ok: true })
    }

    if (action === "send") {
      const a = await auth(req)
      if (!a.ok) return json({ error: a.why }, a.why === "Staff only." ? 403 : 401)
      const to = String(body?.to || "").trim()
      const subject = String(body?.subject || "").trim()
      const text = String(body?.text || "").trim()
      if (!to || !subject || !text) return json({ error: "to, subject and text are required." }, 400)
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: "That email address doesn't look right." }, 400)
      const s = await settings()
      if (!s.gmail_refresh_token) return json({ error: "Gmail isn't connected — connect it in Settings → Email first." }, 400)
      const id = await sendViaGmail(s, {
        to,
        subject,
        text,
        actor: a.email || "Staff",
        portalRequestId: body?.portal_request_id ? String(body.portal_request_id) : undefined,
        customerId: body?.customer_id ? String(body.customer_id) : undefined,
        customerName: body?.customer_name ? String(body.customer_name) : undefined,
      })
      return json({ ok: true, message_id: id })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
