// Customer portal API v2 (public — no staff JWT except admin_data).
//
// Actions (POST JSON { action, ... }):
//   request_link {slug, email}   → magic link email for one known client slug
//   login_email {email}          → email-only login: finds every client with
//                                  that email and sends one email with a login
//                                  button per account (no slug needed)
//   redeem {slug, code}          → one-time code → 30-day portal session token
//   data {token}                 → portal payload: properties, pickups+photos,
//                                  property photos, invoices, quotes, requests,
//                                  saved-card status, balance due
//   setup_session {token, origin, consent} → returns Runner.js config
//                                  (publicKey, mid, env) so the portal can
//                                  render the inline card form; consent required
//   save_card {token, account_token, expiration, cvn?, consent}
//                                  → $0 auth + vault the tokenized card; store
//                                  vault_id + display metadata; Randy texts admins
//   remove_card {token}          → delete vault payment account + clear autopay
//   quote_respond {token, quote_id, response, note} → approve/decline a quote,
//                                  Randy texts admins
//   request_service {token, kind, property_ids, message} → log request, Randy
//                                  texts admins
//   admin_data {customer_id}     → staff-JWT-authorized copy of `data` for the
//                                  CRM's Client Portal preview tab
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
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
}

const enc = encodeURIComponent
const publicUrl = (bucket: string, path: string) => `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`

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
  uat: "https://staging-javelin.runpayments.io",
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
  const r = await fetch(`${runHost(env)}/api/v1/api_keys/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.run_api_key || s.run_refresh_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: s.run_refresh_token }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.message || `Run Merchant key refresh failed: ${r.status}`)
  await sbPatch(`app_settings?id=eq.1`, {
    run_api_key: d.api_key,
    run_refresh_token: d.refresh_token,
    run_api_key_expires_at: new Date(Number(d.api_key_expires_at) * 1000).toISOString(),
    run_refresh_token_expires_at: new Date(Number(d.refresh_token_expires_at) * 1000).toISOString(),
  })
  return { token: d.api_key, mid, env }
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
  "id,name,email,phone,portal_slug,autopay_consent,autopay_consented_at,run_vault_id,run_vault_holder_id,run_card_brand,run_card_last4"

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
    `properties?customer_id=eq.${cust.id}&select=id,name,address,service,pickup_days,pickup_frequency&order=address.asc&limit=200`,
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

  const invoices = await sbGet(
    `invoices?customer_id=eq.${cust.id}&status=neq.draft&select=id,number,status,total,due_date,issue_date,payment_url,run_trans_id&order=issue_date.desc&limit=36`,
  )
  const balanceDue = invoices
    .filter((i: any) => i.status === "sent")
    .reduce((s: number, i: any) => s + Number(i.total || 0), 0)

  const quotes = await sbGet(
    `quotes?customer_id=eq.${cust.id}&status=in.(sent,approved,declined)&select=id,number,title,notes,line_items,subtotal,total,status,sent_at,responded_at,created_at&order=created_at.desc&limit=24`,
  )

  const requests = await sbGet(
    `portal_requests?customer_id=eq.${cust.id}&select=id,kind,message,status,created_at&order=created_at.desc&limit=10`,
  )

  const settings = await getSettings()

  return {
    company: { name: settings.company_name || "Valet Waste FL", logo_url: settings.logo_url || null },
    customer: { name: cust.name, email: cust.email },
    slug: cust.portal_slug,
    properties: props.map((p: any) => ({
      id: p.id, name: p.name, address: p.address, service: p.service,
      pickup_days: p.pickup_days, pickup_frequency: p.pickup_frequency,
    })),
    pickups,
    excess,
    property_photos: propertyPhotos,
    invoices,
    balance_due: balanceDue,
    quotes,
    requests,
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
      const { token, mid, env } = await runAccessToken(settings)

      const alreadySaved = !!cust.run_vault_id
      const res = await runApi(env, token, "charge", {
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
      await sbPatch(`customers?id=eq.${cust.id}`, {
        run_vault_id: res.vault_id ?? null,
        run_vault_holder_id: res.vault_holder_id ?? cust.run_vault_holder_id ?? null,
        run_card_brand: res.card_type || null,
        run_card_last4: String(res.card_number || "").slice(-4) || null,
        run_card_exp: String(body.expiration) || null,
        autopay_consent: !!body.consent,
        autopay_consented_at: body.consent ? new Date().toISOString() : null,
      })
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
          const { token, env } = await runAccessToken(settings)
          await runApi(env, token, `vault_payment_accounts/${cust.run_vault_id}`, { method: "DELETE" })
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
      const kind = ["extra_pickup", "junk_removal", "lawn_care", "billing", "other"].includes(body.kind) ? body.kind : "other"
      const message = String(body.message || "").slice(0, 1000)
      const propertyIds = Array.isArray(body.property_ids) ? body.property_ids.slice(0, 50) : []
      await sbPost("portal_requests", { customer_id: cust.id, kind, message: message || null, property_ids: propertyIds })
      let addrTxt = ""
      if (propertyIds.length) {
        const ps = await sbGet(`properties?id=in.(${propertyIds.join(",")})&customer_id=eq.${cust.id}&select=address&limit=5`)
        addrTxt = ps.length ? ` @ ${ps.map((p: any) => p.address).join("; ")}` : ""
      }
      const kindLabel: Record<string, string> = {
        extra_pickup: "an EXTRA PICKUP", junk_removal: "JUNK REMOVAL", lawn_care: "LAWN CARE", billing: "help with BILLING", other: "service",
      }
      await textAdmins(`📥 ${cust.name} requested ${kindLabel[kind]}${addrTxt} via their portal.${message ? ` "${message.slice(0, 220)}"` : ""} — Trashy Randy`)
      return json({ ok: true })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
