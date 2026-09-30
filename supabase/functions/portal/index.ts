// Customer portal API v2 (public — no staff JWT except admin_data).
//
// Actions (POST JSON { action, ... }):
//   request_link {slug, email}   → magic link email for one known client slug
//   login_email {email}          → email-only login: finds every client with
//                                  that email and sends one email with a login
//                                  button per account (no slug needed)
//   redeem {slug, code}          → one-time code → 30-day portal session token
//   data {token}                 → portal payload: properties, pickups+photos,
//                                  ALL photos (driver service photos with date/
//                                  address/note + staff address-file photos),
//                                  invoices, quotes, requests, saved-card
//                                  status, balance due, notification prefs
//   register_push {token, push_token, platform}
//                                  → app client login/open registers this
//                                  device's Expo push token for the customer
//   unregister_push {token, push_token} → client sign-out drops the device token
//   set_notify_prefs {token, sms?, push?, email?}
//                                  → client-managed notification channels;
//                                  re-enabling texts clears the master opt-out
//   setup_session {token, origin, consent} → returns Runner.js config
//                                  (publicKey, mid, env) so the portal can
//                                  render the inline card form; consent required
//   save_card {token, account_token, expiration, cvn?, consent}
//                                  → $0 auth + vault the tokenized card; store
//                                  vault_id + display metadata; Randy texts admins
//   remove_card {token}          → delete vault payment account + clear autopay
//   quote_respond {token, quote_id, response, note} → approve/decline a quote,
//                                  Randy texts admins
//   request_service {token, kind, property_ids, message, photos} → log request
//                                  (photos: up to 4 image data URLs, resized
//                                  client-side; stored in stop-photos under
//                                  requests/<date>/ and shown in staff triage);
//                                  staff
//                                  get instant email + app push (see
//                                  alertNewPortalRequest) and Randy texts admins
//   admin_data {customer_id}     → staff-JWT-authorized copy of `data` for the
//                                  CRM's Client Portal preview tab
//   admin_invite {customer_id}   → staff-JWT-authorized: email the client their
//                                  7-day portal invite (save-a-card / 5th-week-
//                                  free pitch); also texts when a phone exists
//   signup_config {slug?}        → PUBLIC (no auth): Runner.js public key/mid/env
//                                  + company name/logo so the marketing-site
//                                  signup page can render + brand itself. Also
//                                  returns the web_forms row for the slug
//                                  (intro / line items / pricing / terms),
//                                  or form:null when it's missing or inactive
//   public_signup {…, slug?}     → PUBLIC (no auth): full web signup — creates
//                                  the customer + property (flagged needs_review
//                                  so it lands in the Dashboard "awaiting
//                                  placement" queue), optionally vaults a card
//                                  ($0 auth, 5th-week-free pitch), texts admins.
//                                  Honeypot field `company` must be empty.
//
// Secrets: SENDGRID_API_KEY (required), SENDGRID_FROM. Run Merchant credentials
// live in app_settings (set via the `payments` function's save_credentials).
// Deploy with --no-verify-jwt.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const PORTAL_ORIGIN = Deno.env.get("PORTAL_ORIGIN") || "https://valet-waste-crm.vercel.app"
const SENDGRID_FROM = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}
async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders })
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}
async function sbPost(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}
async function sbPatch(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
  if (!r.ok) console.error(`PATCH ${path}: ${r.status} ${await r.text()}`)
}
async function sbDelete(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "DELETE", headers: restHeaders })
  if (!r.ok) console.error(`DELETE ${path}: ${r.status} ${await r.text()}`)
}
async function sbUpsert(path: string, body: unknown, onConflict: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`UPSERT ${path}: ${r.status} ${await r.text()}`)
}

const enc = encodeURIComponent
const publicUrl = (bucket: string, path: string) => `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`

// Client-attached request photos arrive as data URLs; park the decoded bytes
// in the public stop-photos bucket (same one driver check-in photos use).
// Encode path SEGMENTS only — encoding the slashes themselves (%2F) breaks
// the storage object route.
async function storageUpload(path: string, bytes: Uint8Array, contentType: string) {
  const safePath = path.split("/").map(enc).join("/")
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/stop-photos/${safePath}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes,
  })
  if (!r.ok) throw new Error(`storage upload ${path}: ${r.status} ${await r.text()}`)
}

// Accepts up to 4 image data URLs (the portal resizes to ~1280px JPEG before
// sending), uploads each, returns the storage paths. Bad entries are skipped,
// not fatal — the request itself must still go through.
async function saveRequestPhotos(input: unknown): Promise<{ paths: string[]; errors: string[] }> {
  const paths: string[] = []
  const errors: string[] = []
  if (!Array.isArray(input)) return { paths, errors }
  for (const raw of input.slice(0, 4)) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(raw || ""))
    if (!m) { errors.push("unrecognized entry skipped"); continue }
    if (m[2].length > 4_000_000) { errors.push("image too large, skipped"); continue }
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
    const ext = m[1] === "png" ? "png" : m[1] === "webp" ? "webp" : "jpg"
    const path = `requests/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`
    try {
      await storageUpload(path, bytes, `image/${m[1]}`)
      paths.push(path)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error("request photo upload failed", msg)
      errors.push(msg)
    }
  }
  return { paths, errors }
}

function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("")
}
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// ---- Run Merchant (Run Payments) --------------------------------------------
// Replaces Stripe for saved-card / autopay. The api_key (1h TTL) is minted from
// the long-lived refresh_token; cached in app_settings and refreshed near expiry.
const RUN_HOSTS = {
  uat: "https://javelin-staging.runpayments.io",
  production: "https://javelin.runpayments.io",
}
function runHost(env?: string | null) {
  return RUN_HOSTS[(env === "uat" ? "uat" : "production") as keyof typeof RUN_HOSTS]
}

type RunSettings = {
  run_mid?: string | null
  run_public_key?: string | null
  run_refresh_token?: string | null
  run_api_key?: string | null
  run_api_key_expires_at?: string | null
  run_env?: string | null
}
async function getSettings() {
  return (await sbGet(`app_settings?id=eq.1&select=company_name,logo_url,run_mid,run_public_key,run_refresh_token,run_api_key,run_api_key_expires_at,run_env`))[0] || {}
}

async function runAccessToken(s: RunSettings): Promise<{ token: string; mid: string; env: string }> {
  const mid = s.run_mid || ""
  const env = s.run_env === "uat" ? "uat" : "production"
  if (!mid || !s.run_refresh_token) throw new Error("Payments aren't configured yet — please contact us.")
  const exp = s.run_api_key_expires_at ? new Date(s.run_api_key_expires_at).getTime() : 0
  if (s.run_api_key && exp - Date.now() > 5 * 60 * 1000) return { token: s.run_api_key, mid, env }
  // Refresh uses BOTH the api_key and refresh_token (docs are ambiguous about
  // which goes in the header vs body — try both shapes, PLUS the
  // refresh-token-only shape: a stored api_key can be dead/purged at Run
  // (seen 2026-08-26: expired key returns "Key not found"), and without the
  // third shape that dead key would block a still-valid refresh token.
  const rt = s.run_refresh_token
  const attempts = s.run_api_key
    ? [{ bearer: s.run_api_key, token: rt }, { bearer: rt, token: s.run_api_key }]
    : []
  attempts.push({ bearer: rt, token: rt })
  let d: Record<string, unknown> = {}
  let ok = false
  let status = 0
  for (const a of attempts) {
    const r = await fetch(`${runHost(env)}/api/v1/api_keys/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: a.token }),
    })
    d = await r.json().catch(() => ({}))
    if (r.ok) { ok = true; break }
    status = r.status
  }
  if (!ok) {
    // Yell at the admins instead of letting customers see raw 401s — dead
    // credentials need a new key minted in Run Merchant → Developer API.
    alertAdminsRunCredsDead(status, d).catch(() => {})
    throw new Error((d?.message as string) || (d?.error as string) || `Run Merchant key refresh failed: ${status}`)
  }
  await persistRunTokens(d)
  return { token: d.api_key as string, mid, env }
}

// Email admins when Run credentials are rejected (SendGrid, project secret).
// One email per outage, not per attempt: app_settings.run_creds_alerted_at.
async function alertAdminsRunCredsDead(status: number, d: Record<string, unknown>) {
  try {
    const s = (await sbGet(`app_settings?id=eq.1&select=run_creds_alerted_at`))[0] || {}
    const last = s.run_creds_alerted_at ? new Date(s.run_creds_alerted_at).getTime() : 0
    if (Date.now() - last < 6 * 3600000) return // already alerted in the last 6h
    await sbPatch(`app_settings?id=eq.1`, { run_creds_alerted_at: new Date().toISOString() })
    const key = Deno.env.get("SENDGRID_API_KEY")
    if (!key) return
    const from = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"
    const staff = await sbGet(`profiles?select=email,role&email=not.is.null`)
    const body =
      `Run Payments credentials were rejected (${status} ${JSON.stringify(d).slice(0, 200)}) — ` +
      `card saves and autopay charges are FAILING until this is fixed.\n\n` +
      `Fix: Run Merchant dashboard → Settings → Developer API → Create a new key, then paste it ` +
      `into CRM Settings → Payments. (Sent automatically; repeats at most every 6 hours.)`
    for (const p of staff.filter((x: any) => ["admin", "staff"].includes(x.role || ""))) {
      await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: p.email }] }],
          from: { email: from, name: "Valet Waste" },
          subject: "ACTION NEEDED: Run Payments credentials rejected — card saves failing",
          content: [{ type: "text/plain", value: body }],
        }),
      }).catch(() => {})
    }
  } catch (_e) { /* alerting never breaks payments */ }
}

// A Run refresh consumes the stored refresh token — if this write silently
// failed the successor would be lost forever and every fn would 401. Back it
// up to run_webhook_events (service-role only) on failure so it can be recovered.
async function persistRunTokens(d: Record<string, unknown>) {
  const body = {
    run_api_key: d.api_key,
    run_refresh_token: d.refresh_token,
    run_api_key_expires_at: new Date(Number(d.api_key_expires_at) * 1000).toISOString(),
    run_refresh_token_expires_at: new Date(Number(d.refresh_token_expires_at) * 1000).toISOString(),
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
  if (!r.ok) {
    console.error("Run token persist failed", r.status, await r.text())
    try {
      await sbPost("run_webhook_events", { event_type: "debug.token_persist_failed", payload: d, webhook_id: `debug-${crypto.randomUUID()}` })
    } catch (_e) { console.error("Run token persist backup also failed", _e) }
  }
}

async function runApi(env: string, token: string, path: string, opts: { method?: string; body?: Record<string, unknown> } = {}) {
  const r = await fetch(`${runHost(env)}/api/v1/${path}`, {
    method: opts.method || "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.message || d?.resp_text || `Run Merchant ${r.status}`)
  return d
}

// ---- SMS to admins (Trashy Randy) -------------------------------------------
async function textAdmins(body: string) {
  let sent = 0
  try {
    const staff = await sbGet(`profiles?select=full_name,phone,role&phone=not.is.null&role=eq.admin`)
    for (const s of staff) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send", to: s.phone, body, purpose: "portal", sentBy: "Trashy Randy" }),
        })
        const d = await r.json().catch(() => ({}))
        if (d?.ok) sent++
      } catch (_e) { /* keep going */ }
    }
  } catch (_e) { /* SMS is best-effort */ }
  return sent
}

// ---- Staff alerts for new portal requests (email + app push) -----------------
// Texting is paused (RingCentral, 2026-08-26), so new-request alerts go out
// as email + Expo push the moment a client submits. Config (recipients,
// channels, on/off) lives on the automations row 'new_request_alerts' — that
// status is the kill switch for this instant path too.
const REQUEST_ALERT_EMAILS_DEFAULT = ["david@allsynccrm.com", "valetwastefl@gmail.com"]

function requestAlertConfig(autoRow: any) {
  const c = autoRow?.config || {}
  const emails = Array.isArray(c.emails) ? c.emails.map((e: unknown) => String(e).trim()).filter(Boolean) : []
  return {
    emails: emails.length ? emails : REQUEST_ALERT_EMAILS_DEFAULT,
    email: c.email !== false,
    push: c.push !== false,
  }
}

async function sendStaffAlertEmail(to: string, subject: string, text: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: SENDGRID_FROM, name: "Trashy Randy" },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

async function pushStaffDevices(title: string, body: string): Promise<number> {
  const tokens = await sbGet(`push_tokens?profile_id=not.is.null&select=token&limit=50`)
  let sent = 0
  for (const t of tokens) {
    try {
      const r = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: t.token, title, body, sound: "default" }),
      })
      const d = await r.json().catch(() => ({} as any))
      const rec: any = Array.isArray(d?.data) ? d?.data?.[0] : d?.data // single-message pushes return an object, not an array
      if (r.ok && rec?.status === "ok") sent++
    } catch (_e) { /* best effort per device */ }
  }
  return sent
}

// Sends email + push for a freshly inserted portal_requests row and stamps
// notified_at when anything got out. Best-effort: if every channel fails the
// row stays un-notified and the */5 new_request_alerts automation retries.
async function alertNewPortalRequest(reqId: string, customerName: string, kindLabel: string, addrTxt: string, message: string) {
  try {
    const autoRow = (await sbGet(`automations?kind=eq.new_request_alerts&select=status,config`).catch(() => []))[0]
    if (autoRow && autoRow.status !== "enabled") return // kill switch — poll handles nothing either (it checks the same status)
    const cfg = requestAlertConfig(autoRow)

    const whenEt = new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    const subject = `📥 New portal request — ${customerName} (${kindLabel})`
    const text = [
      `${customerName} just submitted a new request in their client portal.`,
      ``,
      `Type: ${kindLabel}`,
      addrTxt ? `Property: ${addrTxt.replace(/^ @ /, "")}` : null,
      `When: ${whenEt} (Eastern)`,
      message ? `Message: "${message}"` : `Message: (none — just the request)`,
      ``,
      `It's waiting in the CRM under Clients → ${customerName} → Activity.`,
    ].filter((l) => l !== null).join("\n")

    let sent = 0
    if (cfg.email) {
      for (const to of cfg.emails) {
        try { await sendStaffAlertEmail(to, subject, text); sent++ } catch (_e) { /* best effort per address */ }
      }
    }
    if (cfg.push) {
      try { sent += await pushStaffDevices(`📥 New portal request`, `${customerName} — ${kindLabel}${addrTxt}`) } catch (_e) { /* no tokens / Expo down */ }
    }
    if (sent > 0) await sbPatch(`portal_requests?id=eq.${reqId}`, { notified_at: new Date().toISOString() })
  } catch (_e) {
    // Never fail the customer's submission because staff alerting broke.
  }
}

// Human-readable one-block summary of a new_property request's `details` —
// used for the `message` column fallback, texts, and alert emails.
const DAY_SHORT: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
}
const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly",
  "1st_3rd": "1st & 3rd week", "2nd_4th": "2nd & 4th week",
}
function newPropertySummary(d: Record<string, unknown>): string {
  const days = Array.isArray(d.days) ? (d.days as string[]).map((x) => DAY_SHORT[x] || x).join(" & ") : ""
  const freq = FREQ_LABEL[String(d.frequency)] || String(d.frequency || "weekly")
  const notes = d.notes ? `\nNotes: ${d.notes}` : ""
  return `New address: ${d.address}\nService: ${days} (${freq.toLowerCase()})${notes}`
}

// ---- SendGrid ----------------------------------------------------------------
async function sendEmail(to: string, subject: string, html: string, companyName: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: SENDGRID_FROM, name: companyName },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

function magicHtml(customerName: string, links: Array<{ name: string; link: string }>, companyName: string) {
  const buttons = links
    .map(
      (l) => `<p style="margin:14px 0">${links.length > 1 ? `<span style="color:#555;font-size:13px">${l.name}</span><br>` : ""}<a href="${l.link}" style="display:inline-block;background:#1f7a4d;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open my portal</a></p>
<p style="color:#777;font-size:12px;word-break:break-all">${l.link}</p>`,
    )
    .join("")
  return `<p>Hi ${customerName || "there"},</p>
<p>Click below to open your ${companyName} customer portal. ${links.length > 1 ? "You have more than one account with us — each button opens that account's portal. Links work" : "This link works"} once and expire${links.length > 1 ? "" : "s"} in 15 minutes.</p>
${buttons}
<p style="color:#777;font-size:13px">Didn't request this? You can ignore this email.</p>`
}

function codeHtml(customerName: string, code: string, companyName: string) {
  return `<p>Hi ${customerName || "there"},</p>
<p>Here's your ${companyName} portal login code:</p>
<p style="font-size:34px;font-weight:800;letter-spacing:8px;margin:20px 0">${code}</p>
<p style="color:#777;font-size:13px">It works once and expires in 10 minutes. Didn't request this? You can ignore this email.</p>`
}

async function createMagicLink(customerId: string, slug: string): Promise<string> {
  const codeRaw = randomToken(24)
  await sbPost("portal_magic_links", {
    customer_id: customerId,
    code_hash: await sha256(codeRaw),
    expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
  })
  return `${PORTAL_ORIGIN}/?portal=${enc(slug)}&code=${codeRaw}`
}

// ---- session helper ----------------------------------------------------------
const CUST_COLS =
  "id,name,email,phone,portal_slug,autopay_consent,autopay_consented_at,run_vault_id,run_vault_holder_id,run_card_brand,run_card_last4,notify_on_service,notify_sms,notify_push,notify_email"

async function customerFromToken(token: string): Promise<any | null> {
  if (!token) return null
  const hash = await sha256(token)
  const rows = await sbGet(`portal_sessions?token_hash=eq.${hash}&select=id,customer_id,expires_at`)
  const s = rows[0]
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null
  sbPatch(`portal_sessions?id=eq.${s.id}`, { last_seen_at: new Date().toISOString() }).catch(() => {})
  const cust = await sbGet(`customers?id=eq.${s.customer_id}&select=${CUST_COLS}`)
  return cust[0] || null
}

// Staff-JWT check for admin_data (mirrors automations-run).
async function staffFromAuthHeader(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
  if (!token) return false
  if (token === SERVICE_KEY) return true
  const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  })
  if (!ures.ok) return false
  const uid = (await ures.json())?.id
  if (!uid) return false
  const prof = await sbGet(`profiles?id=eq.${uid}&select=role`)
  return ["admin", "staff"].includes(prof?.[0]?.role)
}

// ---- portal data payload -------------------------------------------------------
async function portalData(cust: any) {
  const props = await sbGet(
    `properties?customer_id=eq.${cust.id}&select=id,name,address,service,pickup_days,pickup_frequency,created_at&order=address.asc&limit=200`,
  )
  const propIds = props.map((p: any) => p.id)
  const propById: Record<string, any> = {}
  for (const p of props) propById[p.id] = p

  let pickups: any[] = []
  let excess: any[] = []
  const photosByStop: Record<string, any[]> = {}
  if (propIds.length) {
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
    const stops = await sbGet(
      `route_stops?property_id=in.(${propIds.join(",")})&check_in=not.is.null&select=id,property_id,check_in,check_out,excess_flagged,excess_note,excess_status,excess_amount,routes!inner(service_date)&routes.service_date=gte.${since}&order=check_in.desc&limit=300`,
    )
    const stopIds = stops.map((s: any) => s.id)
    if (stopIds.length) {
      for (let i = 0; i < stopIds.length; i += 80) {
        const chunk = stopIds.slice(i, i + 80)
        const ph = await sbGet(`stop_photos?stop_id=in.(${chunk.join(",")})&select=stop_id,path,created_at&order=created_at.asc`)
        for (const p of ph) {
          photosByStop[p.stop_id] ||= []
          photosByStop[p.stop_id].push({ url: publicUrl("stop-photos", p.path), at: p.created_at })
        }
      }
    }
    pickups = stops.map((s: any) => ({
      date: s.routes?.service_date,
      address: propById[s.property_id]?.address || "",
      checked_in: s.check_in,
      checked_out: s.check_out,
      photos: photosByStop[s.id] || [],
      excess: s.excess_flagged
        ? {
            note: s.excess_note || null,
            status: s.excess_status || "pending",
            amount: s.excess_status === "approved" ? s.excess_amount : null,
          }
        : null,
    }))
    excess = pickups.filter((p: any) => p.excess && p.excess.status !== "dismissed")
  }

  let propertyPhotos: any[] = []
  if (propIds.length) {
    const pp = await sbGet(
      `property_photos?property_id=in.(${propIds.join(",")})&select=property_id,path,image_url,note,taken_on,created_at&order=taken_on.desc.nullslast&limit=200`,
    )
    propertyPhotos = pp.map((p: any) => ({
      address: propById[p.property_id]?.address || "",
      url: p.image_url || (p.path ? publicUrl("property-photos", p.path) : null),
      note: p.note || null,
      date: p.taken_on || p.created_at,
    }))
  }

  // Photos tab: EVERYTHING with details — driver service photos (stop_photos,
  // all time, not just the Pickups tab's 90-day window) merged with the staff
  // "address file" photos above. Invoice-attached photos deliberately stay on
  // the invoice/pay pages (most borrow a stop_photo path and would double-show).
  let servicePhotos: any[] = []
  if (propIds.length) {
    try {
      const stops = await sbGet(
        `route_stops?property_id=in.(${propIds.join(",")})&check_in=not.is.null&select=id,property_id,service,checkin_note,routes!inner(service_date),stop_photos(path,created_at)&order=check_in.desc&limit=400`,
      )
      for (const s of stops) {
        for (const p of s.stop_photos || []) {
          servicePhotos.push({
            date: s.routes?.service_date || p.created_at,
            address: propById[s.property_id]?.address || "",
            service: s.service || propById[s.property_id]?.service || "",
            note: s.checkin_note || null,
            url: publicUrl("stop-photos", p.path),
          })
        }
      }
    } catch (_e) { /* photos never break the portal payload */ }
  }
  const photos = [...servicePhotos, ...propertyPhotos]
    .filter((p: any) => !!p.url)
    .sort((a: any, b: any) => String(b.date || "").localeCompare(String(a.date || "")))

  const invoices = await sbGet(
    `invoices?customer_id=eq.${cust.id}&status=neq.draft&select=id,number,status,total,tip_amount,due_date,issue_date,payment_url,run_trans_id&order=issue_date.desc&limit=36`,
  )
  const balanceDue = invoices
    .filter((i: any) => i.status === "sent")
    .reduce((s: number, i: any) => s + Number(i.total || 0), 0)

  const quotes = await sbGet(
    `quotes?customer_id=eq.${cust.id}&status=in.(sent,approved,declined)&select=id,number,title,notes,line_items,subtotal,total,status,sent_at,responded_at,created_at&order=created_at.desc&limit=24`,
  )

  const requests = await sbGet(
    `portal_requests?customer_id=eq.${cust.id}&select=id,kind,message,status,created_at,photos&order=created_at.desc&limit=10`,
  )

  const settings = await getSettings()

  return {
    company: { name: settings.company_name || "Valet Waste FL", logo_url: settings.logo_url || null },
    customer: { name: cust.name, email: cust.email },
    slug: cust.portal_slug,
    properties: props.map((p: any) => ({
      id: p.id, name: p.name, address: p.address, service: p.service,
      pickup_days: p.pickup_days, pickup_frequency: p.pickup_frequency,
      // 30-day "New" tag on the Home property list (mig 0060) — same window
      // as the Routes NEW badge in the CRM.
      created_at: p.created_at,
    })),
    pickups,
    excess,
    property_photos: propertyPhotos,
    photos,
    notify_prefs: {
      sms: cust.notify_sms !== false,
      push: cust.notify_push !== false,
      email: cust.notify_email !== false,
      // Master opt-out from the email-footer unsubscribe — silences service
      // notifications on every channel until re-enabled in this portal.
      opted_out: cust.notify_on_service === false,
    },
    invoices,
    balance_due: balanceDue,
    quotes,
    requests: (requests as any[]).map((r) => ({
      ...r,
      photos: (Array.isArray(r.photos) ? r.photos : []).map((p: string) => publicUrl("stop-photos", p)),
    })),
    payment: {
      available: !!(settings.run_mid && settings.run_public_key),
      publicKey: settings.run_public_key || null,
      mid: settings.run_mid || null,
      env: settings.run_env || "production",
      saved: !!cust.run_vault_id,
      brand: cust.run_card_brand || null,
      last4: cust.run_card_last4 || null,
      consent: !!cust.autopay_consent,
    },
  }
}

// ---- Web forms (staff-managed public signup pages, mig 0061) --------------------
// Only presentation-safe fields leave these helpers — the public page renders
// exactly what sanitizeFormConfig returns, never the raw config jsonb.
type SignupForm = {
  slug: string
  name: string
  active: boolean
  intro: string | null
  line_items: { description: string; price: number | null }[]
  total_label: string | null
  terms: string | null
  pricing: { one_pickup: number | null; two_pickup: number | null; on_demand_note: string | null }
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null
}
function sanitizeFormConfig(row: any): SignupForm {
  const c = row?.config && typeof row.config === "object" ? row.config : {}
  const p = c.pricing && typeof c.pricing === "object" ? c.pricing : {}
  const lineItems = (Array.isArray(c.line_items) ? c.line_items : [])
    .slice(0, 10)
    .map((li: any) => ({
      description: String(li?.description ?? "").trim().slice(0, 140),
      price: numOrNull(li?.price),
    }))
    .filter((li: { description: string }) => li.description)
  return {
    slug: String(row.slug),
    name: String(row.name || "Sign up").slice(0, 120),
    active: !!row.active,
    intro: String(c.intro || "").trim().slice(0, 400) || null,
    line_items: lineItems,
    total_label: String(c.total_label || "").trim().slice(0, 40) || null,
    terms: String(c.terms || "").trim().slice(0, 2000) || null,
    pricing: {
      one_pickup: numOrNull(p.one_pickup),
      two_pickup: numOrNull(p.two_pickup),
      on_demand_note: String(p.on_demand_note || "").trim().slice(0, 300) || null,
    },
  }
}
async function loadSignupForm(slug: string): Promise<SignupForm | null> {
  const rows = await sbGet(`web_forms?slug=eq.${enc(slug)}&select=slug,name,active,config&limit=1`)
  return rows[0] ? sanitizeFormConfig(rows[0]) : null
}

// ---- HTTP entry -----------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const body = await req.json()
    const { action, slug, email, code, token } = body

    if (action === "request_link") {
      if (!slug || !email) return json({ error: "Missing slug or email." }, 400)
      const generic = { ok: true, message: "If that email matches this account, a login link is on its way." }
      const cs = await sbGet(`customers?portal_slug=eq.${enc(String(slug))}&select=id,name,email,portal_slug`)
      const cust = cs[0]
      if (!cust?.email || cust.email.trim().toLowerCase() !== String(email).trim().toLowerCase()) return json(generic)
      const link = await createMagicLink(cust.id, cust.portal_slug)
      const settings = await getSettings()
      const company = settings.company_name || "Valet Waste FL"
      await sendEmail(cust.email, `Your ${company} portal login link`, magicHtml(cust.name, [{ name: cust.name, link }], company), company)
      return json(generic)
    }

    if (action === "login_email") {
      // Email-only client login from the app's login screen — no slug needed.
      if (!email) return json({ error: "Enter your email." }, 400)
      const generic = { ok: true, message: "If that email is on file, a login link is on its way." }
      const clean = String(email).trim().toLowerCase()
      // ilike with no wildcards = case-insensitive exact match
      const cs = await sbGet(`customers?select=id,name,email,portal_slug&email=ilike.${enc(clean)}&limit=10`)
      const matches = cs.filter((c: any) => c.portal_slug)
      if (!matches.length) return json(generic)
      const links: Array<{ name: string; link: string }> = []
      for (const c of matches.slice(0, 5)) links.push({ name: c.name, link: await createMagicLink(c.id, c.portal_slug) })
      const settings = await getSettings()
      const company = settings.company_name || "Valet Waste FL"
      await sendEmail(clean, `Your ${company} portal login link`, magicHtml(matches[0].name, links, company), company)
      return json(generic)
    }

    if (action === "request_code") {
      // App login screen (native, since 2026-07-27): email → 6-digit code, no
      // magic link. One code is written for EVERY customer record matching the
      // email — property managers hold several, and redeem_code returns an
      // account picker. The app ALWAYS sent request_code/redeem_code; these
      // handlers are the missing other half (before this, app login fell
      // through to "Unknown action.").
      if (!email) return json({ error: "Enter your email." }, 400)
      const generic = { ok: true, message: "If that email is on file, a login code is on its way." }
      const clean = String(email).trim().toLowerCase()
      const cs = await sbGet(`customers?select=id,name,email,portal_slug&email=ilike.${enc(clean)}&limit=10`)
      const matches = cs.filter((c: any) => c.portal_slug)
      if (!matches.length) return json(generic)
      // Throttle like staff-reset: at most 5 codes per hour. Each request
      // writes one row per matched customer, so scale the cap to match.
      const hourAgo = new Date(Date.now() - 3600000).toISOString()
      const ids = matches.map((c: any) => c.id).join(",")
      const recent = await sbGet(`portal_magic_links?customer_id=in.(${ids})&created_at=gte.${hourAgo}&select=id`)
      if ((recent || []).length >= 5 * matches.length) return json(generic)
      const code = String(100000 + Math.floor(Math.random() * 900000))
      const expires = new Date(Date.now() + 10 * 60000).toISOString()
      for (const c of matches.slice(0, 5)) {
        await sbPost("portal_magic_links", { customer_id: c.id, code_hash: await sha256(code), expires_at: expires })
      }
      const settings = await getSettings()
      const company = settings.company_name || "Valet Waste FL"
      await sendEmail(clean, `Your ${company} portal login code`, codeHtml(matches[0].name, code, company), company)
      return json(generic)
    }

    if (action === "redeem_code") {
      if (!email || !code) return json({ error: "Enter the 6-digit code we emailed you." }, 400)
      const clean = String(email).trim().toLowerCase()
      const hash = await sha256(String(code).trim())
      const cs = await sbGet(`customers?select=id,name,portal_slug&email=ilike.${enc(clean)}&limit=10`)
      const matches = cs.filter((c: any) => c.portal_slug)
      const expired = { error: "That code has expired or was already used — request a new one." }
      if (!matches.length) return json(expired, 401)
      const ids = matches.map((c: any) => c.id).join(",")
      const rows = await sbGet(`portal_magic_links?customer_id=in.(${ids})&code_hash=eq.${hash}&select=id,customer_id,expires_at,used_at`)
      const live = rows.filter((r: any) => !r.used_at && new Date(r.expires_at).getTime() > Date.now())
      const accounts: Array<{ name: string, slug: string, token: string }> = []
      for (const c of matches) {
        const row = live.find((r: any) => r.customer_id === c.id)
        if (!row) continue
        await sbPatch(`portal_magic_links?id=eq.${row.id}`, { used_at: new Date().toISOString() })
        const sessionToken = randomToken(32)
        await sbPost("portal_sessions", {
          customer_id: c.id,
          token_hash: await sha256(sessionToken),
          expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        })
        accounts.push({ name: c.name, slug: c.portal_slug, token: sessionToken })
      }
      if (!accounts.length) return json(expired, 401)
      return json({ ok: true, accounts })
    }

    if (action === "redeem") {
      if (!slug || !code) return json({ error: "Missing code." }, 400)
      const cs = await sbGet(`customers?portal_slug=eq.${enc(String(slug))}&select=id,name`)
      const cust = cs[0]
      if (!cust) return json({ error: "This portal link isn't valid." }, 404)
      const hash = await sha256(String(code))
      const links = await sbGet(`portal_magic_links?customer_id=eq.${cust.id}&code_hash=eq.${hash}&select=id,expires_at,used_at`)
      const l = links[0]
      if (!l || l.used_at || new Date(l.expires_at).getTime() < Date.now()) {
        return json({ error: "That login link has expired or was already used — request a new one." }, 401)
      }
      await sbPatch(`portal_magic_links?id=eq.${l.id}`, { used_at: new Date().toISOString() })
      const sessionToken = randomToken(32)
      await sbPost("portal_sessions", {
        customer_id: cust.id,
        token_hash: await sha256(sessionToken),
        expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      })
      return json({ ok: true, token: sessionToken, name: cust.name })
    }

    if (action === "register_push") {
      // App client login/open: register this device's Expo push token against
      // the signed-in customer (portal-session auth; rows written with the
      // service key, so push_tokens.profile_id stays nullable-only for us).
      if (!token) return json({ error: "Not signed in." }, 401)
      const cust = await customerFromToken(String(token))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      const pushToken = String(body.push_token || "").trim()
      if (!pushToken.startsWith("ExpoPushToken[")) return json({ error: "Invalid push token." }, 400)
      await sbUpsert("push_tokens", {
        customer_id: cust.id,
        profile_id: null,
        token: pushToken,
        platform: String(body.platform || "unknown"),
        updated_at: new Date().toISOString(),
      }, "token")
      return json({ ok: true })
    }

    if (action === "unregister_push") {
      // Client sign-out: drop this device's token (other devices keep theirs).
      if (!token) return json({ ok: true })
      const cust = await customerFromToken(String(token))
      if (!cust) return json({ ok: true })
      const pushToken = String(body.push_token || "").trim()
      if (pushToken) await sbDelete(`push_tokens?customer_id=eq.${cust.id}&token=eq.${enc(pushToken)}`)
      return json({ ok: true })
    }

    if (action === "set_notify_prefs") {
      // Client-managed notification channels (🔔 card in the portal). Turning
      // texts back ON also clears the email-footer master opt-out and removes
      // the "No Service Notifications" tag, so footer opt-outs are reversible.
      if (!token) return json({ error: "Not signed in." }, 401)
      const cust = await customerFromToken(String(token))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      const patch: Record<string, unknown> = {}
      if (typeof body.sms === "boolean") patch.notify_sms = body.sms
      if (typeof body.push === "boolean") patch.notify_push = body.push
      if (typeof body.email === "boolean") patch.notify_email = body.email
      if (body.sms === true && cust.notify_on_service === false) {
        patch.notify_on_service = null
        try {
          const tag = (await sbGet(`tags?name=ilike.${enc("No Service Notifications")}&select=id&limit=1`))[0]
          if (tag) await sbDelete(`customer_tags?customer_id=eq.${cust.id}&tag_id=eq.${tag.id}`)
        } catch (_e) { /* tag cleanup is best-effort */ }
      }
      if (Object.keys(patch).length) await sbPatch(`customers?id=eq.${cust.id}`, patch)
      return json({ ok: true })
    }

    if (action === "pay_info") {
      // Standalone pay page — no portal session required. The slug + invoice id
      // pair in the emailed/texted link acts as the bearer capability; we only
      // return this ONE invoice (plus Runner config), never the rest of the
      // portal payload. The charge itself goes through the `payments` fn.
      const invoiceId = String(body.invoice_id || "")
      if (!slug || !invoiceId) return json({ error: "Missing slug or invoice_id." }, 400)
      const cust = (await sbGet(`customers?portal_slug=eq.${enc(String(slug))}&select=id,name,email,phone`))[0]
      if (!cust) return json({ error: "This payment link isn't valid." }, 404)
      const inv = (await sbGet(
        `invoices?id=eq.${enc(invoiceId)}&customer_id=eq.${cust.id}&select=id,number,status,total,tip_amount,subtotal,discount,due_date,issue_date,notes,bill_to_name,bill_to_email,bill_to_phone,invoice_line_items(title,description,quantity,unit_price,amount,position,stop_id)`,
      ))[0]
      if (!inv) return json({ error: "This payment link isn't valid." }, 404)
      const settings = await getSettings()
      // Service photos keyed by stop, attached to the line item that bills
      // each stop (render-time — see payments fn). Photos never break the pay page.
      // The tech's visit note (route_stops.checkin_note) rides the same join.
      const photoByStop = new Map<string, string[]>()
      const noteByStop = new Map<string, string>()
      const lineStopIds = new Set<string>((inv.invoice_line_items || []).map((li: any) => li.stop_id).filter(Boolean))
      const attachedPhotos: Array<{ url: string, taken_on?: string | null, note?: string | null }> = []
      try {
        const stopIds = [...lineStopIds]
        if (stopIds.length) {
          const idList = stopIds.map((id: any) => enc(String(id))).join(",")
          const photos = await sbGet(`stop_photos?stop_id=in.(${idList})&select=stop_id,path&order=created_at.asc`)
          for (const p of photos) {
            const url = `${SUPABASE_URL}/storage/v1/object/public/stop-photos/${enc(String(p.path))}`
            if (!photoByStop.has(p.stop_id)) photoByStop.set(p.stop_id, [])
            photoByStop.get(p.stop_id)!.push(url)
          }
          const stops = await sbGet(`route_stops?id=in.(${idList})&select=id,checkin_note`)
          for (const st of stops) {
            const note = String(st.checkin_note || "").trim()
            if (note) noteByStop.set(st.id, note)
          }
        }
        // Manually attached photos (admin "Add photos"): merge into their
        // line's thumbnails, keep the rest for the trailing grid.
        const invPhotos = await sbGet(`invoice_photos?invoice_id=eq.${enc(invoiceId)}&select=stop_id,path,taken_on,note&order=created_at.asc`)
        for (const p of invPhotos || []) {
          const url = `${SUPABASE_URL}/storage/v1/object/public/stop-photos/${enc(String(p.path))}`
          if (p.stop_id && lineStopIds.has(String(p.stop_id))) {
            if (!photoByStop.has(String(p.stop_id))) photoByStop.set(String(p.stop_id), [])
            photoByStop.get(String(p.stop_id))!.push(url)
          } else {
            attachedPhotos.push({ url, taken_on: p.taken_on, note: p.note })
          }
        }
      } catch (_e) { /* photos never break the pay page */ }
      const items = (inv.invoice_line_items || [])
        .slice()
        .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
        .map((li: any) => ({
          title: li.title || "",
          description: li.description || "",
          quantity: Number(li.quantity || 0),
          unit_price: Number(li.unit_price || 0),
          amount: Number(li.amount || 0),
          photos: li.stop_id ? (photoByStop.get(li.stop_id) || []) : [],
          note: li.stop_id ? (noteByStop.get(li.stop_id) || null) : null,
        }))
      return json({
        ok: true,
        company: {
          name: settings.company_name || "Valet Waste FL",
          logo_url: settings.logo_url || null,
          phone: settings.company_phone || null,
          email: settings.company_email || null,
          address: settings.company_address || null,
        },
        terms: settings.invoice_terms || null,
        // Bill-to override wins when set (e.g. a property manager's end
        // client) — the pay page document shows it; payment itself still runs
        // against the assigned customer.
        customer_name: inv.bill_to_name || cust.name,
        customer_email: inv.bill_to_email || cust.email || null,
        customer_phone: inv.bill_to_phone || cust.phone || null,
        invoice: {
          id: inv.id, number: inv.number, status: inv.status,
          total: inv.total, tip_amount: Number(inv.tip_amount || 0), subtotal: inv.subtotal, discount: inv.discount,
          due_date: inv.due_date, issue_date: inv.issue_date, notes: inv.notes || null, items, attached_photos: attachedPhotos,
        },
        payment: {
          available: !!(settings.run_mid && settings.run_public_key),
          publicKey: settings.run_public_key || null,
          mid: settings.run_mid || null,
          env: settings.run_env || "production",
        },
      })
    }

    if (action === "admin_invite") {
      // CRM "✉ 5th-week-free invite" button (Clients detail). Mirrors the
      // dispatch-ai invite_portal tool: 7-day one-time link (invites live
      // longer than the 15-min email-login links) + the save-a-card pitch.
      if (!(await staffFromAuthHeader(req))) return json({ error: "Staff only." }, 403)
      if (!body.customer_id) return json({ error: "Missing customer_id." }, 400)
      const cust = (await sbGet(`customers?id=eq.${enc(String(body.customer_id))}&select=id,name,phone,email,portal_slug`))[0]
      if (!cust) return json({ error: "Client not found." }, 404)
      if (!cust.portal_slug) return json({ error: `${cust.name} has no portal slug — check the client record.` }, 400)
      if (!cust.email) return json({ error: `${cust.name} has no email on file — add one first.` }, 400)

      const codeRaw = randomToken(24)
      await sbPost("portal_magic_links", {
        customer_id: cust.id,
        code_hash: await sha256(codeRaw),
        expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      })
      const link = `${PORTAL_ORIGIN}/?portal=${enc(cust.portal_slug)}&code=${codeRaw}`
      const settings = await getSettings()
      const company = settings.company_name || "Valet Waste FL"

      const html = `<p>Hi ${cust.name},</p>
<p>Your ${company} customer portal is ready — see invoices, request service, and save a card for easy autopay.</p>
<p><b>Bonus:</b> with a card on file, any month with a 5th pickup week, the 5th week is <b>FREE</b>.</p>
<p style="margin:14px 0"><a href="${link}" style="display:inline-block;background:#1f7a4d;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">Set up my portal</a></p>
<p style="color:#777;font-size:12px;word-break:break-all">${link}</p>
<p style="color:#777;font-size:13px">This link is yours and works once, within 7 days.</p>`
      await sendEmail(cust.email, `Your ${company} portal is ready — 5th pickup week free with autopay`, html, company)

      // Also text when there's a phone (best-effort, same as Randy's invite).
      let sms = false
      if (cust.phone) {
        try {
          const txt = `Hi ${cust.name}, it's ${company}! Your customer portal is ready — see invoices, request service, and save a card for easy autopay. Bonus: with a card on file, any month with a 5th pickup week, the 5th week is FREE. Set up here: ${link} (your link, good for 7 days)`
          const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "send", to: cust.phone, body: txt, customerId: cust.id, purpose: "manual", sentBy: "Trashy Randy" }),
          })
          sms = !!(await r.json().catch(() => ({})))?.ok
        } catch (_e) { /* email already sent */ }
      }
      return json({ ok: true, via: sms ? "email+sms" : "email", to: cust.email })
    }

    if (action === "data") {
      const cust = await customerFromToken(String(token || ""))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      return json({ ok: true, ...(await portalData(cust)) })
    }

    if (action === "admin_data") {
      // CRM preview: staff JWT in the Authorization header, customer_id in body.
      if (!(await staffFromAuthHeader(req))) return json({ error: "Staff only." }, 403)
      if (!body.customer_id) return json({ error: "Missing customer_id." }, 400)
      const cust = (await sbGet(`customers?id=eq.${enc(String(body.customer_id))}&select=${CUST_COLS}`))[0]
      if (!cust) return json({ error: "Client not found." }, 404)
      return json({ ok: true, preview: true, ...(await portalData(cust)) })
    }

    if (action === "setup_session") {
      // No hosted checkout with Run Merchant — return the Runner.js config so
      // the portal can render the inline card form. Consent is required and
      // recorded on save_card once tokenization succeeds.
      const cust = await customerFromToken(String(token || ""))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      if (!body.consent) return json({ error: "Please check the box agreeing to automatic monthly charges first." }, 400)
      const settings = await getSettings()
      if (!settings.run_mid || !settings.run_public_key) return json({ error: "Payments aren't set up yet — please contact us." }, 400)
      return json({
        ok: true,
        publicKey: settings.run_public_key,
        mid: settings.run_mid,
        env: settings.run_env || "production",
      })
    }

    if (action === "save_card") {
      // Runner.js has tokenized the card in the browser; we now vault it via a
      // $0 auth (capture:N, vault:Y). Stores the vault_id + display metadata.
      const cust = await customerFromToken(String(token || ""))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      if (!body.account_token || !body.expiration) return json({ error: "Missing tokenized card details." }, 400)
      const settings = await getSettings()
      if (!settings.run_mid) return json({ error: "Payments aren't set up yet — please contact us." }, 400)
      // NB: name this runToken — a bare `token` here shadows the session token
      // destructured above and TDZ-crashes every earlier `token` use in this block.
      const { token: runToken, mid, env } = await runAccessToken(settings)

      const alreadySaved = !!cust.run_vault_id
      const res = await runApi(env, runToken, "charge", {
        method: "POST",
        body: {
          mid,
          amount: "0.00",
          account_token: String(body.account_token),
          expiration: String(body.expiration),
          capture: "N",
          vault: "Y",
          cof: "C",
          cof_sched: "N",
          cof_perm: body.consent ? "Y" : "N",
          name: cust.name || undefined,
          email: cust.email || undefined,
          cvn: body.cvn ? String(body.cvn) : undefined,
          currency: "USD",
        },
      })
      if (res.result && res.result !== "A") {
        return json({ error: res.resp_text || "Your card couldn't be verified. Please try another card." })
      }
      // TEMP DIAGNOSTIC: capture Run's raw charge response if it lacks a
      // vault_id (mapping question) — see 0038 for the column-type bug this caught.
      console.log("RUN save_card response", JSON.stringify(res))
      if (!res.vault_id) {
        try {
          await sbPost("run_webhook_events", { event_type: "debug.save_card_response", payload: res, webhook_id: `debug-${crypto.randomUUID()}` })
        } catch (_e) { /* non-fatal */ }
      }
      const patchBody = {
        run_vault_id: res.vault_id ?? null,
        run_vault_holder_id: res.vault_holder_id ?? cust.run_vault_holder_id ?? null,
        run_card_brand: res.card_brand || res.card_type || null,
        run_card_last4: String(res.card_number || "").slice(-4) || null,
        run_card_exp: String(body.expiration) || null,
        autopay_consent: !!body.consent,
        autopay_consented_at: body.consent ? new Date().toISOString() : null,
      }
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${cust.id}`, {
        method: "PATCH", headers: restHeaders, body: JSON.stringify(patchBody),
      })
      if (!patchRes.ok) {
        const errText = await patchRes.text()
        console.error("RUN save_card customers PATCH failed", patchRes.status, errText)
        try {
          await sbPost("run_webhook_events", { event_type: "debug.save_card_patch_failed", payload: { status: patchRes.status, body: errText, customer_id: cust.id }, webhook_id: `debug-${crypto.randomUUID()}` })
        } catch (_e) { /* non-fatal */ }
      }
      if (!alreadySaved && body.consent) {
        const cardTxt = res.card_type ? `${String(res.card_type).toUpperCase()} ••${String(res.card_number || "").slice(-4)}` : "a card"
        await textAdmins(
          `💳 ${cust.name} saved their payment method (${cardTxt}) to be charged to invoices — they agreed to automatic charges at the start of each month. 5th-week-free applies. — Trashy Randy`,
        )
      }
      return json({ ok: true, brand: res.card_type || null, last4: String(res.card_number || "").slice(-4) || null })
    }

    if (action === "remove_card") {
      const cust = await customerFromToken(String(token || ""))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      if (cust.run_vault_id) {
        const settings = await getSettings()
        try {
          const { token: runToken, env } = await runAccessToken(settings)
          await runApi(env, runToken, `vault_payment_accounts/${cust.run_vault_id}`, { method: "DELETE" })
        } catch (_e) { /* already gone */ }
      }
      await sbPatch(`customers?id=eq.${cust.id}`, {
        run_vault_id: null, run_vault_holder_id: null,
        run_card_brand: null, run_card_last4: null, run_card_exp: null,
        autopay_consent: false,
      })
      await textAdmins(`💳 ${cust.name} removed their saved payment method — autopay is off for them now. — Trashy Randy`)
      return json({ ok: true })
    }

    if (action === "quote_respond") {
      const cust = await customerFromToken(String(token || ""))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      const response = String(body.response || "")
      if (!body.quote_id || !["approved", "declined"].includes(response)) return json({ error: "Bad request." }, 400)
      const q = (await sbGet(`quotes?id=eq.${enc(String(body.quote_id))}&customer_id=eq.${cust.id}&select=id,number,title,total,status`))[0]
      if (!q) return json({ error: "Quote not found." }, 404)
      if (q.status !== "sent") return json({ error: "This quote can no longer be responded to." }, 400)
      await sbPatch(`quotes?id=eq.${q.id}`, {
        status: response,
        responded_at: new Date().toISOString(),
        response_note: body.note ? String(body.note).slice(0, 500) : null,
      })
      const money = `$${Number(q.total || 0).toFixed(2)}`
      await textAdmins(
        response === "approved"
          ? `✅ ${cust.name} APPROVED quote ${q.number}${q.title ? ` (${q.title})` : ""} — ${money}.${body.note ? ` Note: "${String(body.note).slice(0, 160)}"` : ""} — Trashy Randy`
          : `❌ ${cust.name} declined quote ${q.number}${q.title ? ` (${q.title})` : ""} — ${money}.${body.note ? ` Note: "${String(body.note).slice(0, 160)}"` : ""} — Trashy Randy`,
      )
      return json({ ok: true })
    }

    if (action === "request_service") {
      const cust = await customerFromToken(String(token || ""))
      if (!cust) return json({ error: "Session expired — sign in again." }, 401)
      const kind = ["extra_pickup", "junk_removal", "lawn_care", "billing", "other", "new_property"].includes(body.kind) ? body.kind : "other"
      const message = String(body.message || "").slice(0, 1000)
      const propertyIds = Array.isArray(body.property_ids) ? body.property_ids.slice(0, 50) : []

      // new_property (mig 0060): the structured answers live in `details`
      // {address, days[], frequency, notes}; a readable summary ALSO lands in
      // `message` so the staff email/push and the 0048 backstop poll render
      // complete info without knowing the new shape.
      let details: Record<string, unknown> | null = null
      if (kind === "new_property") {
        const d = body.details && typeof body.details === "object" ? body.details as Record<string, unknown> : {}
        const address = String(d.address || "").trim().slice(0, 300)
        const days = (Array.isArray(d.days) ? d.days : [])
          .map((x: unknown) => String(x).toLowerCase())
          .filter((x: string) => ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].includes(x))
          .slice(0, 7)
        const frequency = ["weekly", "biweekly", "monthly", "1st_3rd", "2nd_4th"].includes(String(d.frequency)) ? String(d.frequency) : "weekly"
        const notes = String(d.notes || "").trim().slice(0, 1000)
        if (!address || !days.length) return json({ error: "Add the new address and pick at least one service day." }, 400)
        details = { address, days, frequency, notes: notes || null }
      }

      const { paths: photoPaths, errors: photoErrors } = await saveRequestPhotos(body.photos)
      const inserted = await sbPost("portal_requests", {
        customer_id: cust.id, kind,
        message: message || (details ? newPropertySummary(details) : null),
        property_ids: kind === "new_property" ? [] : propertyIds,
        photos: photoPaths,
        details,
      })
      const reqId = inserted?.[0]?.id
      let addrTxt = ""
      if (kind === "new_property" && details) {
        addrTxt = ` @ ${details.address}`
      } else if (propertyIds.length) {
        const ps = await sbGet(`properties?id=in.(${propertyIds.join(",")})&customer_id=eq.${cust.id}&select=address&limit=5`)
        addrTxt = ps.length ? ` @ ${ps.map((p: any) => p.address).join("; ")}` : ""
      }
      const kindLabel: Record<string, string> = {
        extra_pickup: "an EXTRA PICKUP", junk_removal: "JUNK REMOVAL", lawn_care: "LAWN CARE", billing: "help with BILLING", other: "service", new_property: "a NEW PROPERTY be added",
      }
      const alertLabel: Record<string, string> = {
        extra_pickup: "Extra pickup", junk_removal: "Junk removal", lawn_care: "Lawn care", billing: "Billing question", other: "Service request", new_property: "New property",
      }
      const photoTxt = photoPaths.length ? ` [${photoPaths.length} photo${photoPaths.length > 1 ? "s" : ""} attached — see the Dashboard triage]` : ""
      await textAdmins(`📥 ${cust.name} requested ${kindLabel[kind]}${addrTxt} via their portal.${message ? ` "${message.slice(0, 220)}"` : ""}${photoTxt} — Trashy Randy`)
      if (reqId) await alertNewPortalRequest(String(reqId), cust.name || "A client", alertLabel[kind] || "Service request", addrTxt, `${message || (details ? newPropertySummary(details) : "(no description)")}${photoTxt}`)
      return json({ ok: true, photos_saved: photoPaths.length, photo_errors: photoErrors })
    }

    if (action === "signup_config") {
      // Public — the marketing-site signup page needs the Runner.js config to
      // tokenize cards and the company name/logo to brand itself. Only
      // publishable values leave this action (same payload the portal's own
      // setup_session hands out, minus anything requiring a client session).
      // Pass slug to get that web form's intro/pricing/terms; unknown or
      // inactive slugs return form:null and the page shows "unavailable".
      const slug = String(body.slug || "default").trim().slice(0, 60) || "default"
      const settings = await getSettings()
      if (!settings.run_mid || !settings.run_public_key) return json({ error: "Signup is temporarily unavailable — please call us to start service." }, 400)
      const form = await loadSignupForm(slug)
      return json({
        ok: true,
        publicKey: settings.run_public_key,
        mid: settings.run_mid,
        env: settings.run_env || "production",
        company_name: settings.company_name || "Valet Waste",
        logo_url: settings.logo_url || null,
        form: form && form.active ? form : null,
      })
    }

    if (action === "public_signup") {
      // Public web signup (Trashbolt-style agreement, Approve-button e-consent).
      // Order matters: the optional card is vaulted BEFORE any row is created
      // (a vault failure must not leave a half-created account behind — the
      // user fixes the card and resubmits the same form).
      const ALL_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

      // Honeypot: bots fill the hidden "company" field. Pretend success so the
      // bot doesn't learn anything; create nothing.
      if (String(body.company || "").trim()) return json({ ok: true })

      // The web form this came from must exist and be active (an inactive form
      // must never accept signups — staff unpublished it for a reason).
      const slug = String(body.slug || "default").trim().slice(0, 60) || "default"
      const form = await loadSignupForm(slug)
      if (!form || !form.active) return json({ error: "This signup form is no longer available — please call us to start service." }, 400)

      const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max)
      const firstName = str(body.first_name, 80)
      const lastName = str(body.last_name, 80)
      const phone = str(body.phone, 30)
      const email = str(body.email, 200).toLowerCase()
      const street = str(body.street, 200)
      const city = str(body.city, 100)
      const state = str(body.state, 20)
      const zip = str(body.zip, 20)
      const scheduleType = str(body.schedule_type, 20) === "on_call" ? "on_call" : "weekly"
      const pickupsPerWeek = scheduleType === "weekly" ? (Number(body.pickups_per_week) === 2 ? 2 : 1) : 0
      const serviceDays = (Array.isArray(body.service_days) ? body.service_days : [])
        .map((x: unknown) => String(x).toLowerCase())
        .filter((x: string) => ALL_DAYS.includes(x))
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(str(body.start_date, 10)) ? str(body.start_date, 10) : null
      const notes = str(body.notes, 1000)
      const ebilling = !!body.ebilling

      if (!firstName || !lastName) return json({ error: "Please enter your first and last name." }, 400)
      if (phone.replace(/\D/g, "").length < 10) return json({ error: "Please enter a valid phone number." }, 400)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400)
      if (!street || !city || !state || !zip) return json({ error: "Please enter your full service address." }, 400)
      if (scheduleType === "weekly" && serviceDays.length !== pickupsPerWeek) {
        return json({ error: pickupsPerWeek === 2 ? "Please pick two service days." : "Please pick a service day." }, 400)
      }
      if (!body.agreed) return json({ error: "Please review the agreement and tap Approve to start service." }, 400)

      // Billing address (defaults to the service address)
      const bSame = body.billing_same !== false
      const bStreet = bSame ? street : str(body.billing_street, 200)
      const bCity = bSame ? city : str(body.billing_city, 100)
      const bState = bSame ? state : str(body.billing_state, 20)
      const bZip = bSame ? zip : str(body.billing_zip, 20)
      if (!bStreet || !bCity || !bState || !bZip) return json({ error: "Please enter your full billing address." }, 400)

      // Optional card-on-file (5th-week-free pitch). Browser tokenizes via
      // Runner.js; we vault here with a $0 auth, same as save_card.
      const card = body.card && typeof body.card === "object" ? body.card as Record<string, unknown> : null
      let vault: Record<string, unknown> | null = null
      if (card && card.account_token) {
        const settings = await getSettings()
        if (!settings.run_mid) return json({ error: "Payments aren't set up yet — please skip the card and we'll bill you after your first visit." }, 400)
        const { token: runToken, mid, env } = await runAccessToken(settings)
        const res = await runApi(env, runToken, "charge", {
          method: "POST",
          body: {
            mid,
            amount: "0.00",
            account_token: String(card.account_token),
            expiration: String(card.expiration || ""),
            capture: "N",
            vault: "Y",
            cof: "C",
            cof_sched: "N",
            cof_perm: card.consent ? "Y" : "N",
            name: `${firstName} ${lastName}`,
            email,
            cvn: card.cvn ? String(card.cvn) : undefined,
            currency: "USD",
          },
        })
        if (res.result && res.result !== "A") {
          return json({ error: `${res.resp_text || "Your card couldn't be verified."} — you were not signed up; please fix the card or choose "bill me after my first visit" and try again.`, card_declined: true })
        }
        vault = {
          run_vault_id: res.vault_id ?? null,
          run_vault_holder_id: res.vault_holder_id ?? null,
          run_card_brand: res.card_brand || res.card_type || null,
          run_card_last4: String(res.card_number || "").slice(-4) || null,
          run_card_exp: String(card.expiration) || null,
          autopay_consent: !!card.consent,
          autopay_consented_at: card.consent ? new Date().toISOString() : null,
        }
      }

      // Consent record — the Approve button IS the signature; keep the evidence
      // on the customer row (timestamp + IP), like the PandaDoc signer record.
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
      const nowIso = new Date().toISOString()
      const addr = `${street}, ${city}, ${state} ${zip}`
      const billAddr = bSame ? addr : `${bStreet}, ${bCity}, ${bState} ${bZip}`
      const name = `${firstName} ${lastName}`
      const price = scheduleType === "weekly" ? (pickupsPerWeek === 2 ? form.pricing.two_pickup : form.pricing.one_pickup) : null
      const scheduleTxt = scheduleType === "on_call"
        ? "On-Demand (price varies — reach out after signup)"
        : `${serviceDays.join(" + ")} — ${pickupsPerWeek} pickup${pickupsPerWeek > 1 ? "s" : ""}/week${price != null ? ` ($${price.toFixed(2)}/wk)` : ""}`
      const consentNote = `Web signup agreement approved ${nowIso}${ip ? ` (IP ${ip})` : ""} — ${scheduleTxt}. Form: ${form.name} (${slug}).`
      const noteParts = [consentNote]
      if (!bSame) noteParts.push(`Billing address: ${billAddr}`)
      if (ebilling) noteParts.push("Enrolled in e-billing.")
      if (notes) noteParts.push(`Service notes: ${notes}`)
      if (!vault) noteParts.push("No card on file — bill after first visit.")

      const inserted = await sbPost("customers", {
        name,
        email,
        phone,
        address: billAddr,
        status: "active",
        business_line: "waste",
        billing_type: scheduleType === "on_call" ? "one_time" : "subscription",
        lead_source: "web_form",
        notes: noteParts.join("\n"),
        ...(vault || {}),
      })
      const custId = inserted?.[0]?.id
      if (!custId) return json({ error: "Signup could not be saved — please call us to start service." }, 500)

      const prop = await sbPost("properties", {
        customer_id: custId,
        name: `${name} — ${street}`,
        address: addr,
        service: "Trash",
        notes: scheduleType === "on_call" ? `ON-DEMAND service. ${notes || ""}`.trim() : (notes || null),
        price,
        pickup_days: scheduleType === "weekly" ? serviceDays : [],
        pickup_frequency: scheduleType,
        pickup_start_date: scheduleType === "weekly" ? startDate : null,
        needs_review: true,
        business_line: "waste",
        paused: false,
      })

      // Admins get a text (staff_alert path — unaffected by the client-texting
      // pause). The property itself lands in the Dashboard "awaiting placement"
      // queue + ★ NEW badge until staff slot it onto a route.
      const cardTxt = vault?.run_card_last4 ? ` Card on file ${String(vault.run_card_brand || "card").toUpperCase()} ••${vault.run_card_last4} (5th week free).` : " No card on file — bill after first visit."
      const startTxt = startDate && scheduleType === "weekly" ? ` starting ${startDate}` : ""
      const noteTxt = notes ? ` Notes: "${notes.slice(0, 160)}"` : ""
      await textAdmins(`🌐 New web signup (${form.name}): ${name} @ ${addr} — ${scheduleTxt}${startTxt}.${cardTxt}${noteTxt} — Trashy Randy`)

      return json({ ok: true, customer_id: custId, property_id: prop?.[0]?.id || null, card_saved: !!vault })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
