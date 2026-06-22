// RingCentral SMS (+ Telnyx fallback) — config + outbound send.
//
// Mirrors the old Replit CRM: RingCentral takes priority over Telnyx for all
// outbound SMS when it's enabled and configured.
//
// Actions (POST JSON { action, ... }):
//   get_config            → non-secret config + secret-presence flags
//   save_config {config}  → upsert config; secrets only overwritten when a new
//                           non-empty value is supplied (blank = keep existing)
//   send {to, body, customerId?}  → send one SMS, logged to sms_messages
//   test {to}             → send a short test message
//
// Secrets required (set as Supabase function secrets / env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (injected automatically)
//   TELNYX_API_KEY, TELNYX_FROM               (optional — only for fallback)
// RingCentral creds (Client ID/Secret, JWT, From #) are stored in the DB via
// the Settings UI, not as function secrets.
//
// Deploy with JWT verification OFF (the browser calls with the anon key):
//   supabase functions deploy sms --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}

// ---- DB helpers (PostgREST with the service role) --------------------------
async function getSettings(): Promise<Record<string, unknown>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=*`, { headers: restHeaders })
  const rows = await r.json()
  return rows[0] || {}
}
async function patchSettings(patch: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify(patch),
  })
}
async function getSecrets(): Promise<Record<string, string | null>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/sms_secrets?id=eq.1&select=*`, { headers: restHeaders })
  const rows = await r.json()
  return rows[0] || {}
}
async function patchSecrets(patch: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/sms_secrets?id=eq.1`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  })
}
async function logMessage(row: Record<string, unknown>) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/sms_messages`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify(row),
    })
  } catch (_e) { /* logging must never break a send */ }
}

// ---- Phone helper: normalize to E.164 (US default) -------------------------
function e164(raw: string): string {
  if (!raw) return raw
  const t = raw.trim()
  if (t.startsWith("+")) return "+" + t.slice(1).replace(/\D/g, "")
  const digits = t.replace(/\D/g, "")
  if (digits.length === 10) return "+1" + digits
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits
  return "+" + digits
}

// ---- RingCentral: JWT → access token → send --------------------------------
async function rcToken(server: string, clientId: string, clientSecret: string, jwt: string): Promise<string> {
  const basic = btoa(`${clientId}:${clientSecret}`)
  const r = await fetch(`${server.replace(/\/+$/, "")}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`RingCentral auth ${r.status}: ${d?.error_description || d?.message || JSON.stringify(d)}`)
  return d.access_token as string
}

async function rcSend(server: string, token: string, from: string, to: string, text: string) {
  const r = await fetch(`${server.replace(/\/+$/, "")}/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`RingCentral send ${r.status}: ${d?.message || JSON.stringify(d)}`)
  return d
}

// ---- Telnyx fallback -------------------------------------------------------
async function telnyxSend(from: string, to: string, text: string) {
  const key = Deno.env.get("TELNYX_API_KEY")
  if (!key) throw new Error("Telnyx fallback isn't configured (TELNYX_API_KEY not set).")
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, text }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`Telnyx send ${r.status}: ${d?.errors?.[0]?.detail || JSON.stringify(d)}`)
  return d
}

// ---- RingCentral subscriptions (inbound webhook lifecycle) ----------------
// RingCentral push subscriptions expire, so the old app created them via the
// API and renewed any within 7 days of expiry every 6h. Here the create/renew
// live as edge-function actions; a pg_cron job calls `renew_subscriptions`.
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/sms-webhook`
const SMS_EVENT_FILTER = "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function rcServer(settings: Record<string, unknown>): string {
  return String(settings.rc_server_url || "https://platform.ringcentral.com").replace(/\/+$/, "")
}
async function rcAuth(settings: Record<string, unknown>, secrets: Record<string, string | null>): Promise<string> {
  return rcToken(rcServer(settings), String(settings.rc_client_id), String(secrets.rc_client_secret), String(secrets.rc_jwt))
}
function isSmsSub(s: any): boolean {
  return (s?.eventFilters || []).some((f: string) => f.includes("message-store/instant") && f.toLowerCase().includes("sms"))
}
async function rcListSubscriptions(server: string, token: string): Promise<any[]> {
  const r = await fetch(`${server}/restapi/v1.0/subscription`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
  const d = await r.json()
  if (!r.ok) throw new Error(`RingCentral list subscriptions ${r.status}: ${d?.message || JSON.stringify(d)}`)
  return (d.records || []) as any[]
}
async function rcCreateSmsSubscription(server: string, token: string, verificationToken?: string | null): Promise<any> {
  const deliveryMode: Record<string, unknown> = { transportType: "WebHook", address: WEBHOOK_URL }
  if (verificationToken) deliveryMode.verificationToken = verificationToken
  const r = await fetch(`${server}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ eventFilters: [SMS_EVENT_FILTER], deliveryMode }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`RingCentral create subscription ${r.status}: ${d?.message || JSON.stringify(d)}`)
  return d
}
async function rcRenewSubscription(server: string, token: string, id: string): Promise<any> {
  const r = await fetch(`${server}/restapi/v1.0/subscription/${encodeURIComponent(id)}/renew`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`RingCentral renew subscription ${r.status}: ${d?.message || JSON.stringify(d)}`)
  return d
}
async function rcDeleteSubscription(server: string, token: string, id: string): Promise<void> {
  const r = await fetch(`${server}/restapi/v1.0/subscription/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok && r.status !== 404) throw new Error(`RingCentral delete subscription ${r.status}`)
}

// Ensure exactly one active SMS subscription points at our webhook.
async function ensureSubscription(): Promise<any> {
  const settings = await getSettings()
  const secrets = await getSecrets()
  if (!settings.rc_client_id || !secrets.rc_client_secret || !secrets.rc_jwt) {
    throw new Error("Enter and save your RingCentral Client ID, Client Secret, and JWT first.")
  }
  const server = rcServer(settings)
  const token = await rcAuth(settings, secrets)
  const subs = await rcListSubscriptions(server, token)
  const ours = subs.find((s) => isSmsSub(s) && s?.deliveryMode?.address === WEBHOOK_URL && (s.status || "").toLowerCase() === "active")
  if (ours) return ours
  return rcCreateSmsSubscription(server, token, secrets.rc_webhook_verification_token)
}

// Renew any SMS subscription expiring within 7 days (cron target).
async function renewSubscriptions(): Promise<{ renewed: number; total: number }> {
  const settings = await getSettings()
  const secrets = await getSecrets()
  if (!settings.rc_client_id || !secrets.rc_client_secret || !secrets.rc_jwt) return { renewed: 0, total: 0 }
  const server = rcServer(settings)
  const token = await rcAuth(settings, secrets)
  const subs = (await rcListSubscriptions(server, token)).filter(isSmsSub)
  const now = Date.now()
  let renewed = 0
  for (const s of subs) {
    if ((s.status || "").toLowerCase() !== "active" || !s.expirationTime) continue
    const expMs = new Date(s.expirationTime).getTime()
    if (Number.isFinite(expMs) && expMs - now < SEVEN_DAYS_MS) {
      try { await rcRenewSubscription(server, token, s.id); renewed++ } catch (_e) { /* retry next cycle */ }
    }
  }
  return { renewed, total: subs.length }
}

// ---- Core send: pick provider, send, log -----------------------------------
async function sendSms(to: string, body: string, customerId?: string | null, purpose?: string | null, sentBy?: string | null) {
  const settings = await getSettings()
  const secrets = await getSecrets()
  const toNum = e164(to)
  const meta = { purpose: purpose || null, sent_by: sentBy || null }

  const rcReady =
    settings.sms_enabled &&
    settings.rc_client_id &&
    settings.sms_from_number &&
    secrets.rc_client_secret &&
    secrets.rc_jwt

  // RingCentral first (matches old app priority)
  if (rcReady) {
    const from = e164(String(settings.sms_from_number))
    try {
      const token = await rcToken(
        String(settings.rc_server_url || "https://platform.ringcentral.com"),
        String(settings.rc_client_id),
        String(secrets.rc_client_secret),
        String(secrets.rc_jwt),
      )
      const d = await rcSend(String(settings.rc_server_url || "https://platform.ringcentral.com"), token, from, toNum, body)
      await logMessage({ direction: "out", provider: "ringcentral", to_number: toNum, from_number: from, body, status: "sent", customer_id: customerId || null, external_id: d?.id ? String(d.id) : null, ...meta })
      return { ok: true, provider: "ringcentral", id: d?.id }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // fall through to Telnyx if available; otherwise surface the error
      if (!Deno.env.get("TELNYX_API_KEY")) {
        await logMessage({ direction: "out", provider: "ringcentral", to_number: toNum, body, status: "failed", error: msg, customer_id: customerId || null, ...meta })
        throw e
      }
    }
  }

  // Telnyx fallback
  const telnyxFrom = e164(Deno.env.get("TELNYX_FROM") || String(settings.sms_from_number || ""))
  try {
    const d = await telnyxSend(telnyxFrom, toNum, body)
    await logMessage({ direction: "out", provider: "telnyx", to_number: toNum, from_number: telnyxFrom, body, status: "sent", customer_id: customerId || null, external_id: d?.data?.id ? String(d.data.id) : null, ...meta })
    return { ok: true, provider: "telnyx", id: d?.data?.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logMessage({ direction: "out", provider: "telnyx", to_number: toNum, body, status: "failed", error: msg, customer_id: customerId || null, ...meta })
    throw e
  }
}

// ---- HTTP entry ------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const { action, config, to, body, customerId, id, purpose, sentBy } = await req.json()

    if (action === "get_config") {
      const s = await getSettings()
      return json({
        sms_enabled: !!s.sms_enabled,
        sms_from_number: s.sms_from_number || "",
        rc_server_url: s.rc_server_url || "https://platform.ringcentral.com",
        rc_client_id: s.rc_client_id || "",
        rc_secret_set: !!s.rc_secret_set,
        rc_jwt_set: !!s.rc_jwt_set,
        rc_webhook_token_set: !!s.rc_webhook_token_set,
        webhook_url: `${SUPABASE_URL}/functions/v1/sms-webhook`,
      })
    }

    if (action === "save_config") {
      const c = config || {}
      // Non-secret fields → app_settings
      const patch: Record<string, unknown> = {
        sms_enabled: !!c.sms_enabled,
        sms_from_number: c.sms_from_number || null,
        rc_server_url: c.rc_server_url || "https://platform.ringcentral.com",
        rc_client_id: c.rc_client_id || null,
        updated_at: new Date().toISOString(),
      }
      // Secret fields → sms_secrets, only when a new non-empty value is given
      const secretPatch: Record<string, unknown> = {}
      if (typeof c.rc_client_secret === "string" && c.rc_client_secret.trim()) {
        secretPatch.rc_client_secret = c.rc_client_secret.trim()
        patch.rc_secret_set = true
      }
      if (typeof c.rc_jwt === "string" && c.rc_jwt.trim()) {
        secretPatch.rc_jwt = c.rc_jwt.trim()
        patch.rc_jwt_set = true
      }
      if (typeof c.rc_webhook_verification_token === "string") {
        // allow clearing this one (it's optional)
        secretPatch.rc_webhook_verification_token = c.rc_webhook_verification_token.trim() || null
        patch.rc_webhook_token_set = !!c.rc_webhook_verification_token.trim()
      }
      if (Object.keys(secretPatch).length) await patchSecrets(secretPatch)
      await patchSettings(patch)
      return json({ ok: true })
    }

    if (action === "send") {
      if (!to || !body) return json({ error: "Both 'to' and 'body' are required." }, 400)
      const r = await sendSms(String(to), String(body), customerId, purpose, sentBy)
      return json(r)
    }

    if (action === "test") {
      if (!to) return json({ error: "A 'to' number is required." }, 400)
      const r = await sendSms(String(to), "Test message from Valet Waste FL CRM", null)
      return json(r)
    }

    // --- inbound-webhook subscription lifecycle ---
    if (action === "list_subscriptions") {
      const settings = await getSettings()
      const secrets = await getSecrets()
      if (!settings.rc_client_id || !secrets.rc_client_secret || !secrets.rc_jwt) return json({ subscriptions: [] })
      const server = rcServer(settings)
      const token = await rcAuth(settings, secrets)
      const subs = (await rcListSubscriptions(server, token)).filter(isSmsSub)
      return json({ subscriptions: subs, webhook_url: WEBHOOK_URL })
    }

    if (action === "ensure_subscription") {
      const sub = await ensureSubscription()
      return json({ ok: true, subscription: sub })
    }

    if (action === "renew_subscriptions") {
      const r = await renewSubscriptions()
      return json({ ok: true, ...r })
    }

    if (action === "delete_subscription") {
      if (!id) return json({ error: "A subscription id is required." }, 400)
      const settings = await getSettings()
      const secrets = await getSecrets()
      const server = rcServer(settings)
      const token = await rcAuth(settings, secrets)
      await rcDeleteSubscription(server, token, String(id))
      return json({ ok: true })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) })
  }
})
