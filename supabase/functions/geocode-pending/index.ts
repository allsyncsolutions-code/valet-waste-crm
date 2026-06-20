// Fills in lat/lng for properties that don't have coordinates yet.
//
// Geocoding is rate-limited (OpenStreetMap Nominatim ~1 req/sec), so this does
// a small THROTTLED batch per call and returns how many remain — the caller
// (Import screen or Randy) loops until remaining = 0. Keeps any single
// invocation well under the function time limit.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
const enc = encodeURIComponent
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rest(path: string, opts: { method?: string; body?: unknown; prefer?: string } = {}) {
  const headers: Record<string, string> = { ...svc, "Content-Type": "application/json" }
  if (opts.prefer) headers["Prefer"] = opts.prefer
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const t = await r.text()
  const d = t ? JSON.parse(t) : null
  if (!r.ok) throw new Error((d && d.message) || `REST ${r.status}`)
  return d
}

async function geocode(address: string) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${enc(address)}`,
      { headers: { "User-Agent": "ValetWasteCRM/1.0 (geocode-pending)" } })
    if (!r.ok) return null
    const rows = await r.json()
    if (!rows?.length) return null
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lon) }
  } catch { return null }
}

// Eligible = no coords yet, has an address, and hasn't failed too many times.
const PENDING = "lat=is.null&address=not.is.null&geocode_attempts=lt.3"

async function countRemaining(): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/properties?${PENDING}&select=id`,
    { headers: { ...svc, Prefer: "count=exact", Range: "0-0" } })
  const cr = r.headers.get("content-range") || "*/0"
  return Number(cr.split("/")[1] || 0)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    // Require an authenticated staff caller.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    if (!token) return json({ error: "Not signed in." }, 401)
    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
    if (!ures.ok) return json({ error: "Invalid session." }, 401)
    const caller = await ures.json()
    const prof = await rest(`profiles?id=eq.${caller.id}&select=role`)
    if (!["admin", "staff"].includes(prof?.[0]?.role)) return json({ error: "Staff only." }, 403)

    const body = await req.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(body.limit) || 15, 1), 25)

    // Least-tried first, so a few un-geocodable addresses never block the rest.
    const rows = await rest(`properties?${PENDING}&select=id,address,geocode_attempts&order=geocode_attempts.asc&limit=${limit}`)
    let updated = 0
    for (let i = 0; i < rows.length; i++) {
      const loc = await geocode(rows[i].address)
      if (loc) {
        await rest(`properties?id=eq.${rows[i].id}`, { method: "PATCH", prefer: "return=minimal", body: { lat: loc.lat, lng: loc.lng } })
        updated++
      } else {
        // Record the miss so this row drops out after a few tries.
        await rest(`properties?id=eq.${rows[i].id}`, { method: "PATCH", prefer: "return=minimal", body: { geocode_attempts: (rows[i].geocode_attempts || 0) + 1 } })
      }
      if (i < rows.length - 1) await sleep(1100) // respect Nominatim's ~1 req/sec policy
    }
    const remaining = await countRemaining()
    return json({ processed: rows.length, updated, remaining })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
