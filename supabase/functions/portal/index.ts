// Customer portal API (public — no staff JWT).
//
// Actions (POST JSON { action, ... }):
//   request_link {slug, email} → if email matches the client, email a one-time
//                                login link via SendGrid (always returns ok to
//                                avoid email enumeration)
//   redeem {slug, code}        → exchange a fresh emailed code for a 30-day
//                                portal session token
//   data {token}               → the client's portal payload: properties,
//                                pickups (timestamps + photos), property
//                                photos, excess flags, invoices
//
// Secrets: SENDGRID_API_KEY (required), SENDGRID_FROM (default below).
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

async function sendMagicEmail(to: string, customerName: string, link: string, companyName: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: SENDGRID_FROM, name: companyName },
      subject: `Your ${companyName} portal login link`,
      content: [{
        type: "text/html",
        value: `<p>Hi ${customerName || "there"},</p>
<p>Click below to open your ${companyName} customer portal. This link works once and expires in 15 minutes.</p>
<p><a href="${link}" style="display:inline-block;background:#1f7a4d;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">Open my portal</a></p>
<p style="color:#777;font-size:13px">If the button doesn't work, paste this into your browser:<br>${link}</p>
<p style="color:#777;font-size:13px">Didn't request this? You can ignore this email.</p>`,
      }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

// ---- session helper ---------------------------------------------------------
async function customerFromToken(token: string): Promise<any | null> {
  if (!token) return null
  const hash = await sha256(token)
  const rows = await sbGet(`portal_sessions?token_hash=eq.${hash}&select=id,customer_id,expires_at`)
  const s = rows[0]
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null
  sbPatch(`portal_sessions?id=eq.${s.id}`, { last_seen_at: new Date().toISOString() }).catch(() => {})
  const cust = await sbGet(`customers?id=eq.${s.customer_id}&select=id,name,email,phone,portal_slug`)
  return cust[0] || null
}

// ---- portal data payload ----------------------------------------------------
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
      // chunk the id list so the URL stays sane
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
            // Only show a dollar amount once an admin approved it.
            amount: s.excess_status === "approved" ? s.excess_amount : null,
          }
        : null,
    }))
    excess = pickups.filter((p: any) => p.excess && p.excess.status !== "dismissed")
  }

  let propertyPhotos: any[] = []
  if (propIds.length) {
    const pp = await sbGet(
      `property_photos?property_id=in.(${propIds.join(",")})&select=property_id,path,note,photo_date,created_at&order=photo_date.desc&limit=200`,
    )
    propertyPhotos = pp.map((p: any) => ({
      address: propById[p.property_id]?.address || "",
      url: p.path ? publicUrl("property-photos", p.path) : null,
      note: p.note || null,
      date: p.photo_date || p.created_at,
    }))
  }

  const invoices = await sbGet(
    `invoices?customer_id=eq.${cust.id}&status=neq.draft&select=number,status,total,due_date,issue_date,stripe_payment_url&order=issue_date.desc&limit=36`,
  )

  const settings = (await sbGet(`app_settings?id=eq.1&select=company_name,logo_url`))[0] || {}

  return {
    company: { name: settings.company_name || "Valet Waste FL", logo_url: settings.logo_url || null },
    customer: { name: cust.name, email: cust.email },
    properties: props.map((p: any) => ({ address: p.address, service: p.service, pickup_days: p.pickup_days })),
    pickups,
    excess,
    property_photos: propertyPhotos,
    invoices,
  }
}

// ---- HTTP entry -------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const { action, slug, email, code, token } = await req.json()

    if (action === "request_link") {
      if (!slug || !email) return json({ error: "Missing slug or email." }, 400)
      const generic = { ok: true, message: "If that email matches this account, a login link is on its way." }
      const cs = await sbGet(`customers?portal_slug=eq.${enc(String(slug))}&select=id,name,email`)
      const cust = cs[0]
      if (!cust?.email || cust.email.trim().toLowerCase() !== String(email).trim().toLowerCase()) return json(generic)
      // one-time code, 15 min
      const codeRaw = randomToken(24)
      await sbPost("portal_magic_links", {
        customer_id: cust.id,
        code_hash: await sha256(codeRaw),
        expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
      })
      const settings = (await sbGet(`app_settings?id=eq.1&select=company_name`))[0] || {}
      const link = `${PORTAL_ORIGIN}/?portal=${enc(String(slug))}&code=${codeRaw}`
      await sendMagicEmail(cust.email, cust.name, link, settings.company_name || "Valet Waste FL")
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

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
