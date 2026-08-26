// Run Merchant (Run Payments) — customer-facing payments for staff/crm.
//
// Replaces the old `stripe` edge function (Connect onboarding + Checkout pay
// links). Run Merchant has no hosted checkout, so invoice "pay links" now
// point at the in-portal Runner.js pay screen (see the portal function's
// pay_invoice flow). Merchant credentials are entered once in Settings (no
// hosted onboarding).
//
// Actions (POST JSON { action, ... }):
//   status                          → { connected, mid, env }
//   save_credentials {mid, public_key, refresh_token, env, webhook_secret?}
//                                   → stores merchant creds in app_settings
//   payment_url {invoice_id, origin}→ mints/stores the portal pay link for an
//                                     invoice, returns { url }; marks the
//                                     invoice 'sent' the first time.
//   charge_invoice {invoice_id, account_token, expiration, cvn, name?, address?, save_card?}
//                                   → runs a one-time charge via /charge; on
//                                     approval stores run_trans_id and marks the
//                                     invoice paid. Optionally vaults the card.
//   email_invoice {invoice_id, origin}
//                                   → emails the customer an HTML invoice (line
//                                     items, totals, terms) with a Pay Now button
//                                     via SendGrid; mints the pay link if needed
//                                     and marks the invoice 'sent'.
//
// Auth: verify_jwt OFF — the charge action is invoked from the public portal
// pay screen (anon key + invoice context), mirroring the portal function.
// Staff-only actions (save_credentials) require the service key or a staff JWT.
//
// Secrets: none beyond the auto-injected SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// Run Merchant tokens live in app_settings (set via save_credentials).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const PORTAL_ORIGIN = Deno.env.get("PORTAL_ORIGIN") || "https://valet-waste-crm.vercel.app"

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
async function sbPatch(path: string, body: unknown) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
}
async function sbPost(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify(body),
  })
  return r
}
const enc = encodeURIComponent

// ---- crypto helpers ----------------------------------------------------------
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// ---- reveal allowlist + email ------------------------------------------------
// Who may request a reveal code. Enforced server-side only — never ship to client.
const REVEAL_ALLOWLIST = ["david@allsynccrm.com", "francesca@runpayments.io"]
async function sendRevealEmail(to: string, code: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const from = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: "Valet Waste CRM" },
      subject: "Your Run Merchant key reveal code",
      content: [{ type: "text/html", value: `<p>Someone requested to view the Run Merchant credentials in Valet Waste Settings.</p><p>Your code is: <b style="font-size:20px;letter-spacing:2px">${code}</b></p><p>It expires in 15 minutes. If you didn't request this, you can ignore this email.</p>` }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

// Mask a secret for display: show first 4 + last 4, hide the middle.
function mask(s: string | null | undefined): string | null {
  if (!s) return null
  if (s.length <= 8) return "•".repeat(s.length)
  return `${s.slice(0, 4)}${"•".repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`
}

// ---- Run Merchant API helpers ------------------------------------------------
// Base host flips between UAT and production by merchant env. api_key (1h TTL)
// is minted from the long-lived refresh_token; we cache it in app_settings and
// only refresh within 5 minutes of expiry.
const RUN_HOSTS = {
  uat: "https://javelin-staging.runpayments.io",
  production: "https://javelin.runpayments.io",
}
type RunSettings = {
  run_mid?: string | null
  run_public_key?: string | null
  run_refresh_token?: string | null
  run_api_key?: string | null
  run_api_key_expires_at?: string | null
  run_env?: string | null
}
async function getSettings(): Promise<RunSettings & { id: number }> {
  const rows = await sbGet(`app_settings?id=eq.1&select=*`)
  return rows[0] || {}
}

function runHost(env?: string | null) {
  return RUN_HOSTS[(env === "uat" ? "uat" : "production") as keyof typeof RUN_HOSTS]
}

// Mint a fresh api_key from the stored api_key + refresh_token pair. Run's
// docs say the refresh uses BOTH credentials but are ambiguous about which
// goes in the Authorization header vs the body — so try the primary shape
// first and the swapped shape on failure. Without a stored api_key (legacy
// state) fall back to refresh-token-only, which Run may reject.
async function runKeyRefresh(env: string, apiKey: string | null, refreshToken: string) {
  const attempts = apiKey
    ? [{ bearer: apiKey, token: refreshToken }, { bearer: refreshToken, token: apiKey }]
    : [{ bearer: refreshToken, token: refreshToken }]
  let last: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
  for (const a of attempts) {
    const r = await fetch(`${runHost(env)}/api/v1/api_keys/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: a.token }),
    })
    const d = await r.json().catch(() => ({}))
    if (r.ok) return d
    last = { status: r.status, body: d }
  }
  const hint = apiKey ? "" : " — the API Key may be missing: paste it from the Run portal in Settings → Payments."
  throw new Error((last.body?.message as string) || (last.body?.error as string) || `Run Merchant key refresh failed: ${last.status}${hint}`)
}

// Return a live bearer token, refreshing first if the cached api_key is near
// expiry. Mutates app_settings with the new key on refresh.
async function getAccessToken(s: RunSettings): Promise<{ token: string; mid: string; env: string }> {
  const mid = s.run_mid || ""
  const env = s.run_env === "uat" ? "uat" : "production"
  if (!mid || !s.run_refresh_token) throw new Error("Run Merchant isn't configured — add your credentials in Settings.")
  const exp = s.run_api_key_expires_at ? new Date(s.run_api_key_expires_at).getTime() : 0
  const fiveMin = 5 * 60 * 1000
  if (s.run_api_key && exp - Date.now() > fiveMin) {
    return { token: s.run_api_key, mid, env }
  }
  const d = await runKeyRefresh(env, s.run_api_key || null, s.run_refresh_token)
  await persistRunTokens(d)
  return { token: d.api_key, mid, env }
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

interface ChargeBody {
  mid: string
  amount: number // cents
  account_token?: string
  expiration?: string
  vault_id?: number
  vault_holder_id?: string
  capture?: string // 'Y' | 'N'
  vault?: string // 'Y' | 'N'
  cof?: string // 'C' | 'M'
  cof_sched?: string // 'Y' | 'N'
  cof_perm?: string
  name?: string
  email?: string
  address1?: string
  city?: string
  region?: string
  country?: string
  account_zip?: string
  cvn?: string
  currency?: string
  invoice_id?: string
  order_id?: string
  [k: string]: unknown
}
async function runCharge(env: string, token: string, body: ChargeBody) {
  const r = await fetch(`${runHost(env)}/api/v1/charge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.message || d?.resp_text || `Run Merchant charge failed: ${r.status}`)
  return d
}

// Vault a tokenized card without charging ($0 auth). Used when the customer
// checks "save for autopay" during a one-time invoice payment.
async function runVaultCreate(env: string, token: string, body: Record<string, unknown>) {
  const r = await fetch(`${runHost(env)}/api/v1/vault_payment_accounts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.message || `Run Merchant vault create failed: ${r.status}`)
  return d
}

// ---- invoice email (SendGrid) -------------------------------------------------
// Plain-text fallback for the invoice email (same content as the HTML below).
function invoiceEmailText(c: Record<string, unknown>, s: Record<string, unknown>, inv: Record<string, unknown>, items: Array<Record<string, unknown>>, url: string) {
  const company = s.company_name || "Valet Waste FL"
  const money = (v: unknown) => "$" + Number(v || 0).toFixed(2)
  const lines = items.map((it) => `  ${it.title ? it.title + ": " : ""}${it.description || "Service"} x${it.quantity} — ${money(it.amount)}`)
  return [
    `Hi ${c.name || "there"},`,
    ``,
    `Invoice ${inv.number} from ${company} is ready.`,
    ...lines,
    `Subtotal: ${money(inv.subtotal)}`,
    Number(inv.discount) ? `Discount: -${money(inv.discount)}` : "",
    `Total due${inv.due_date ? ` by ${String(inv.due_date).slice(0, 10)}` : ""}: ${money(inv.total)}`,
    ``,
    `Pay online: ${url}`,
    inv.notes ? `\nNotes: ${inv.notes}` : "",
    s.invoice_terms ? `\n${s.invoice_terms}` : "",
    ``,
    `Thank you!`,
    [s.company_name, s.company_phone, s.company_email].filter(Boolean).join(" · "),
  ].filter((l) => l !== "").join("\n")
}

function invoiceEmailHtml(c: Record<string, unknown>, s: Record<string, unknown>, inv: Record<string, unknown>, items: Array<Record<string, unknown>>, url: string) {
  const company = s.company_name || "Valet Waste FL"
  const money = (v: unknown) => "$" + Number(v || 0).toFixed(2)
  const esc = (t: unknown) => String(t ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[ch])
  const rows = items
    .map((it) => `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #e6ece8;font-size:14px;color:#1a2420">${it.title ? `<div style="font-weight:700">${esc(it.title)}</div>` : ""}${esc(it.description || (it.title ? "" : "Service"))}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e6ece8;font-size:14px;color:#5d6b63;text-align:center;white-space:nowrap">${it.quantity}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e6ece8;font-size:14px;color:#5d6b63;text-align:right;white-space:nowrap">${money(it.unit_price)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e6ece8;font-size:14px;color:#1a2420;text-align:right;white-space:nowrap">${money(it.amount)}</td>
    </tr>`)
    .join("")
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px 12px;background:#f2f5f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e0e7e2">
    <div style="background:#1f7a4d;color:#fff;padding:22px 26px">
      <div style="font-size:18px;font-weight:700">${esc(company)}</div>
      <div style="font-size:13px;opacity:.85;margin-top:2px">Invoice ${esc(inv.number)}${inv.due_date ? ` · Due ${esc(String(inv.due_date).slice(0, 10))}` : ""}</div>
    </div>
    <div style="padding:26px">
      <p style="margin:0 0 18px;font-size:15px;color:#1a2420">Hi ${esc(c.name || "there")}, your invoice is ready. Total due: <b>${money(inv.total)}</b></p>
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#f7faf8">
          <th style="padding:8px 10px;text-align:left;font-size:12px;color:#7c8a82;text-transform:uppercase;letter-spacing:.04em">Item</th>
          <th style="padding:8px 10px;text-align:center;font-size:12px;color:#7c8a82;text-transform:uppercase;letter-spacing:.04em">Qty</th>
          <th style="padding:8px 10px;text-align:right;font-size:12px;color:#7c8a82;text-transform:uppercase;letter-spacing:.04em">Rate</th>
          <th style="padding:8px 10px;text-align:right;font-size:12px;color:#7c8a82;text-transform:uppercase;letter-spacing:.04em">Amount</th>
        </tr>
        ${rows}
        <tr><td colspan="3" style="padding:9px 10px;font-size:13px;color:#5d6b63;text-align:right">Subtotal</td><td style="padding:9px 10px;font-size:13px;color:#5d6b63;text-align:right">${money(inv.subtotal)}</td></tr>
        ${Number(inv.discount) ? `<tr><td colspan="3" style="padding:4px 10px;font-size:13px;color:#5d6b63;text-align:right">Discount</td><td style="padding:4px 10px;font-size:13px;color:#5d6b63;text-align:right">-${money(inv.discount)}</td></tr>` : ""}
        <tr><td colspan="3" style="padding:6px 10px;font-size:15px;font-weight:700;color:#1a2420;text-align:right">Total</td><td style="padding:6px 10px;font-size:15px;font-weight:700;color:#1f7a4d;text-align:right">${money(inv.total)}</td></tr>
      </table>
      <div style="text-align:center;margin:26px 0 8px">
        <a href="${url}" style="display:inline-block;background:#1f7a4d;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 34px;border-radius:9px">Pay Now</a>
        <div style="font-size:12px;color:#7c8a82;margin-top:10px;word-break:break-all">Or paste this link: ${url}</div>
      </div>
      ${inv.notes ? `<p style="margin:18px 0 0;font-size:13px;color:#5d6b63"><b>Notes:</b> ${esc(inv.notes)}</p>` : ""}
      ${s.invoice_terms ? `<p style="margin:14px 0 0;font-size:12px;color:#7c8a82;border-top:1px solid #e6ece8;padding-top:14px">${esc(s.invoice_terms)}</p>` : ""}
    </div>
    <div style="padding:16px 26px;background:#f7faf8;border-top:1px solid #e6ece8;font-size:12px;color:#7c8a82">
      ${[s.company_phone, s.company_email, s.company_address].filter(Boolean).map((v) => `<div>${esc(v)}</div>`).join("")}
    </div>
  </div>
</body></html>`
}

async function sendInvoiceEmail(to: string, subject: string, html: string, text: string, fromName: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const from = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: fromName },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

// ---- staff auth for save_credentials -----------------------------------------
async function isStaff(req: Request): Promise<boolean> {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
  if (!t) return false
  if (t === SERVICE_KEY) return true
  const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${t}` } })
  if (!ures.ok) return false
  const uid = (await ures.json())?.id
  if (!uid) return false
  const prof = await sbGet(`profiles?id=eq.${uid}&select=role`)
  return ["admin", "staff"].includes(prof?.[0]?.role)
}

// ---- HTTP entry --------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const body = await req.json()
    const { action } = body

    if (action === "status") {
      const s = await getSettings()
      // Return masked secrets for display — never plaintext here. Plaintext is
      // only returned by reveal_verify after a code is confirmed.
      return json({
        connected: !!(s.run_mid && s.run_public_key && s.run_refresh_token),
        ready: !!(s.run_mid && s.run_public_key && s.run_refresh_token),
        env: s.run_env || "production",
        mid: s.run_mid || null,
        fields: {
          mid: s.run_mid ? { set: true, masked: mask(s.run_mid) } : { set: false },
          public_key: s.run_public_key ? { set: true, masked: mask(s.run_public_key) } : { set: false },
          api_key: s.run_api_key ? { set: true, masked: mask(s.run_api_key) } : { set: false },
          refresh_token: s.run_refresh_token ? { set: true, masked: mask(s.run_refresh_token) } : { set: false },
          webhook_secret: s.run_webhook_secret ? { set: true, masked: mask(s.run_webhook_secret) } : { set: false },
        },
        refresh_token_expires_at: s.run_refresh_token_expires_at || null,
        // Runner.js config for the staff "Take payment" form. The public key is
        // client-side by design (it's served to every portal pay page).
        runner: s.run_mid && s.run_public_key
          ? { public_key: s.run_public_key, mid: s.run_mid, env: s.run_env || "production" }
          : null,
      })
    }

    if (action === "save_credentials") {
      if (!(await isStaff(req))) return json({ error: "Staff only." }, 403)
      const patch: Record<string, unknown> = {}
      if (typeof body.mid === "string" && body.mid.trim()) patch.run_mid = body.mid.trim()
      if (typeof body.public_key === "string" && body.public_key.trim()) patch.run_public_key = body.public_key.trim()
      if (typeof body.refresh_token === "string" && body.refresh_token.trim()) {
        patch.run_refresh_token = body.refresh_token.trim()
        // Force a fresh access-token mint on next API call (unless a new
        // api_key arrives in this same save, below).
        patch.run_api_key = null
        patch.run_api_key_expires_at = null
      }
      if (typeof body.api_key === "string" && body.api_key.trim()) {
        // The portal-issued api_key lives ~1h; assume it was just generated so
        // charges can use it immediately. If it's actually stale, the charge
        // 401s and the refresh path takes over.
        patch.run_api_key = body.api_key.trim()
        patch.run_api_key_expires_at = new Date(Date.now() + 30 * 60000).toISOString()
      }
      if (body.env === "uat" || body.env === "production") patch.run_env = body.env
      if (typeof body.webhook_secret === "string" && body.webhook_secret.trim()) patch.run_webhook_secret = body.webhook_secret.trim()
      if (!Object.keys(patch).length) return json({ error: "Nothing to save — enter at least one value." }, 400)
      await sbPatch(`app_settings?id=eq.1`, patch)
      return json({ ok: true })
    }

    if (action === "reveal_request") {
      // Always return generic success so the allowlist isn't leaked. Only
      // allowlisted emails actually get a code emailed.
      const email = String(body.email || "").trim().toLowerCase()
      const generic = { ok: true, message: "If that email is approved, a 6-digit code is on its way." }
      if (!REVEAL_ALLOWLIST.includes(email)) return json(generic)
      // 6-digit code.
      const code = String(Math.floor(100000 + Math.random() * 900000))
      await sbPost("run_reveal_codes", {
        email,
        code_hash: await sha256(code),
        expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
      })
      try { await sendRevealEmail(email, code) } catch (e) { return json({ error: "Could not send the code email: " + (e instanceof Error ? e.message : String(e)) }) }
      return json(generic)
    }

    if (action === "reveal_verify") {
      const email = String(body.email || "").trim().toLowerCase()
      const code = String(body.code || "").trim()
      if (!REVEAL_ALLOWLIST.includes(email) || !code) return json({ error: "Invalid code." }, 400)
      const hash = await sha256(code)
      const rows = await sbGet(`run_reveal_codes?email=eq.${enc(email)}&code_hash=eq.${hash}&order=created_at.desc&limit=1`)
      const r = rows[0]
      if (!r || r.used_at || new Date(r.expires_at).getTime() < Date.now()) {
        return json({ error: "That code is invalid or expired — request a new one." }, 400)
      }
      await sbPatch(`run_reveal_codes?id=eq.${r.id}`, { used_at: new Date().toISOString() })
      const s = await getSettings()
      return json({
        ok: true,
        mid: s.run_mid || null,
        public_key: s.run_public_key || null,
        api_key: s.run_api_key || null,
        refresh_token: s.run_refresh_token || null,
        webhook_secret: s.run_webhook_secret || null,
      })
    }

    if (action === "payment_url") {
      if (!body.invoice_id) return json({ error: "Missing invoice_id." }, 400)
      const inv = (await sbGet(`invoices?id=eq.${enc(String(body.invoice_id))}&select=id,number,customer_id,status,payment_url`))[0]
      if (!inv) return json({ error: "Invoice not found." }, 404)
      const cust = (await sbGet(`customers?id=eq.${inv.customer_id}&select=portal_slug`))[0]
      if (!cust?.portal_slug) return json({ error: "This customer has no portal — add a portal slug first." }, 400)
      // Reuse an existing link if we already minted one; otherwise build it.
      let url = inv.payment_url
      const origin = String(body.origin || PORTAL_ORIGIN).replace(/\/$/, "")
      if (!url) {
        url = `${origin}/?portal=${enc(cust.portal_slug)}&pay_invoice=${enc(String(inv.id))}`
        const patch: Record<string, unknown> = { payment_url: url }
        if (inv.status === "draft") {
          patch.status = "sent"
          patch.sent_at = new Date().toISOString()
        }
        await sbPatch(`invoices?id=eq.${inv.id}`, patch)
      }
      return json({ ok: true, url })
    }

    if (action === "email_invoice") {
      if (!body.invoice_id) return json({ error: "Missing invoice_id." }, 400)
      const inv = (await sbGet(
        `invoices?id=eq.${enc(String(body.invoice_id))}&select=id,number,customer_id,status,payment_url,subtotal,discount,total,due_date,issue_date,notes`,
      ))[0]
      if (!inv) return json({ error: "Invoice not found." }, 404)
      if (inv.status === "void") return json({ error: "This invoice is void." }, 400)
      const cust = (await sbGet(`customers?id=eq.${inv.customer_id}&select=name,email,portal_slug`))[0]
      if (!cust?.email) return json({ error: "This customer has no email on file." }, 400)
      if (!cust?.portal_slug) return json({ error: "This customer has no portal — add a portal slug first." }, 400)

      // Reuse the stored pay link, or mint one (marks the invoice sent).
      const origin = String(body.origin || PORTAL_ORIGIN).replace(/\/$/, "")
      let url = inv.payment_url
      if (!url) {
        url = `${origin}/?portal=${enc(cust.portal_slug)}&pay_invoice=${enc(String(inv.id))}`
        const patch: Record<string, unknown> = { payment_url: url }
        if (inv.status === "draft") {
          patch.status = "sent"
          patch.sent_at = new Date().toISOString()
        }
        await sbPatch(`invoices?id=eq.${inv.id}`, patch)
      }

      const items = await sbGet(`invoice_line_items?invoice_id=eq.${inv.id}&select=title,description,quantity,unit_price,amount&order=position`)
      const s = await getSettings()
      const company = s.company_name || "Valet Waste FL"
      const money = (v: unknown) => "$" + Number(v || 0).toFixed(2)
      const subject = `${company} — Invoice ${inv.number} (${money(inv.total)})`
      await sendInvoiceEmail(
        cust.email,
        subject,
        invoiceEmailHtml(cust, s, inv, items, url),
        invoiceEmailText(cust, s, inv, items, url),
        company,
      )
      return json({ ok: true, url, to: cust.email })
    }

    if (action === "charge_invoice") {
      if (!body.invoice_id) return json({ error: "Missing invoice_id." }, 400)
      const inv = (await sbGet(
        `invoices?id=eq.${enc(String(body.invoice_id))}&select=id,number,total,status,customer_id`,
      ))[0]
      if (!inv) return json({ error: "Invoice not found." }, 404)
      if (inv.status === "paid") return json({ error: "This invoice is already paid." }, 400)
      const cents = Math.round(Number(inv.total || 0) * 100)
      if (cents < 50) return json({ error: "Invoice total must be at least $0.50." }, 400)

      const settings = await getSettings()
      const { token, mid, env } = await getAccessToken(settings)
      const cust = (await sbGet(`customers?id=eq.${inv.customer_id}&select=id,name,email,phone,run_vault_id,run_vault_holder_id`))[0] || {}

      const chargeBody: ChargeBody = {
        mid,
        amount: cents,
        capture: "Y",
        currency: "USD",
        invoice_id: String(inv.id),
        order_id: String(inv.id),
        cof: "C",
        cof_sched: "N",
        name: body.name || cust.name || undefined,
        email: cust.email || undefined,
      }
      if (body.use_saved) {
        // Staff "Take payment" with the customer's card on file (vaulted).
        if (!cust.run_vault_id) return json({ error: "No saved card on file for this customer." }, 400)
        chargeBody.vault_id = cust.run_vault_id
        chargeBody.vault_holder_id = cust.run_vault_holder_id || undefined
        chargeBody.cof = "M" // merchant-initiated, card on file
      } else if (body.account_token && body.expiration) {
        chargeBody.account_token = String(body.account_token)
        chargeBody.expiration = String(body.expiration)
        if (body.cvn) chargeBody.cvn = String(body.cvn)
        if (body.address) Object.assign(chargeBody, body.address) // address1, city, region, country, account_zip
      } else {
        return json({ error: "Missing card details." }, 400)
      }
      // Save-for-autopay during payment: vault the card too.
      if (body.save_card) {
        chargeBody.vault = "Y"
        chargeBody.cof_perm = "Y"
      }

      let res
      try {
        res = await runCharge(env, token, chargeBody)
      } catch (e) {
        // A stale cached api_key comes back as a 401 — force one refresh and
        // retry the charge before giving up.
        const msg = e instanceof Error ? e.message : String(e)
        if (/\b401\b/.test(msg)) {
          const fresh = await getAccessToken({ ...settings, run_api_key_expires_at: null })
          res = await runCharge(fresh.env, fresh.token, chargeBody)
        } else {
          throw e
        }
      }
      if (res.result !== "A") {
        return json({ ok: false, declined: true, result: res.result, resp_text: res.resp_text || "Declined", trans_id: res.trans_id || null })
      }

      const patch: Record<string, unknown> = {
        status: "paid",
        paid_at: new Date().toISOString(),
        run_paid_at: new Date().toISOString(),
        run_trans_id: String(res.trans_id),
      }
      await sbPatch(`invoices?id=eq.${inv.id}`, patch)

      // Optional: store the card on file for autopay.
      let saved = false
      if (body.save_card && (res.vault_id || res.vault_holder_id)) {
        await sbPatch(`customers?id=eq.${cust.id}`, {
          run_vault_id: res.vault_id ?? null,
          run_vault_holder_id: res.vault_holder_id ?? cust.run_vault_holder_id ?? null,
          run_card_brand: res.card_type || null,
          run_card_last4: String(res.card_number || "").slice(-4) || null,
          run_card_exp: String(body.expiration || "") || null,
          autopay_consent: true,
          autopay_consented_at: new Date().toISOString(),
        })
        saved = true
      }

      return json({ ok: true, trans_id: res.trans_id, resp_text: res.resp_text, saved })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
