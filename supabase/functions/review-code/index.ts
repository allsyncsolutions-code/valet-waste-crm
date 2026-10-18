// Static review-login codes for App Store Connect demo access.
//
// The app portal login emails a fresh random 6-digit code per request, which
// made review depend on us reading an inbox within the 10-minute code window.
// This fn mints N portal_magic_links rows with the SAME code hash — each
// redeem consumes exactly one row, so one code works N times. Gated by the
// REVIEW_ADMIN_KEY env secret (set via `supabase secrets set`), callable only
// with that key; rows can be revoked any time (action "revoke").
//
// Deploy:  supabase functions deploy review-code --no-verify-jwt
// Mint:    { action:"mint", code:"402916", uses:100, days:120 }
// Revoke:  { action:"revoke", code:"402916" }

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const ADMIN_KEY = Deno.env.get("REVIEW_ADMIN_KEY") || ""
// The App Review demo customer (email valetwastefl@gmail.com, slug app-review-demo)
const DEMO_CUSTOMER_ID = "38f9e7b4-4eda-4e81-a7ba-9021307f0a8e"

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function sbPost(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`)
}

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: svc })
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`)
  return await r.json()
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })
  try {
    if (!ADMIN_KEY) return json({ error: "REVIEW_ADMIN_KEY not configured." }, 500)
    if (req.headers.get("x-admin-key") !== ADMIN_KEY) return json({ error: "Forbidden." }, 403)

    const body = await req.json().catch(() => ({}))
    const code = String(body.code || "").trim()
    if (!/^\d{6}$/.test(code)) return json({ error: "code must be exactly 6 digits." }, 400)

    // The demo customer must still exist.
    const cust = await sbGet(`customers?id=eq.${DEMO_CUSTOMER_ID}&select=id,email,portal_slug`)
    if (!cust?.[0]?.portal_slug) return json({ error: "Demo customer missing or has no portal slug." }, 404)

    if (body.action === "mint") {
      const uses = Math.min(500, Math.max(1, Number(body.uses) || 100))
      const days = Math.min(365, Math.max(1, Number(body.days) || 120))
      const hash = await sha256(code)
      const expires = new Date(Date.now() + days * 86400000).toISOString()
      const rows = Array.from({ length: uses }, () => ({ customer_id: DEMO_CUSTOMER_ID, code_hash: hash, expires_at: expires }))
      // Insert in modest batches so a huge `uses` can't blow the payload limit.
      for (let i = 0; i < rows.length; i += 50) {
        await sbPost("portal_magic_links", rows.slice(i, i + 50))
      }
      return json({ ok: true, code, uses, days, customer: cust[0].email })
    }

    if (body.action === "revoke") {
      const hash = await sha256(code)
      const r = await fetch(`${SUPABASE_URL}/rest/v1/portal_magic_links?customer_id=eq.${DEMO_CUSTOMER_ID}&code_hash=eq.${hash}&used_at=is.null`, {
        method: "DELETE",
        headers: svc,
      })
      if (!r.ok) throw new Error(`DELETE: ${r.status} ${await r.text()}`)
      return json({ ok: true, revoked: true })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
