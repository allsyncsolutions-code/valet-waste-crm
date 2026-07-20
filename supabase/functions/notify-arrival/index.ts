// Arrival notification — "your Valet Waste tech is at your property now."
//
// Fired when a tech checks in at a stop. Texts the property's contact UNLESS
// they're a property manager tied to 2+ properties (to avoid blasting a
// multi-location manager with dozens of texts a day) — unless that contact has
// an explicit per-contact override.
//
//   customers.notify_on_service:  TRUE = always notify, FALSE = never,
//                                 NULL = auto (notify only single-property contacts)
//   route_stops.arrival_notified_at:  atomic at-most-once guard per stop.
//
// The actual SMS goes out through the existing `sms` edge function's `send`
// action, so provider selection (RingCentral→Telnyx) and logging are reused.
//
// Deploy with JWT verification OFF (clients call with the anon key):
//   supabase functions deploy notify-arrival --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const rest = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}

async function countCustomerProperties(customerId: string): Promise<number> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?customer_id=eq.${customerId}&select=id`,
    { headers: { ...rest, Prefer: "count=exact" } },
  )
  const cr = r.headers.get("content-range") || ""
  const total = Number(cr.split("/")[1])
  if (Number.isFinite(total)) return total
  const rows = await r.json()
  return Array.isArray(rows) ? rows.length : 0
}

// Flip arrival_notified_at NULL→now. Returns true only for the winning caller.
async function claimArrival(stopId: string): Promise<boolean> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/route_stops?id=eq.${stopId}&arrival_notified_at=is.null`,
    { method: "PATCH", headers: { ...rest, Prefer: "return=representation" },
      body: JSON.stringify({ arrival_notified_at: new Date().toISOString() }) },
  )
  const rows = await r.json()
  return Array.isArray(rows) && rows.length > 0
}
async function releaseArrival(stopId: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/route_stops?id=eq.${stopId}`, {
      method: "PATCH", headers: rest, body: JSON.stringify({ arrival_notified_at: null }),
    })
  } catch (_e) { /* best effort */ }
}

// Send via the existing `sms` function's `send` action (reuses provider + logging).
async function sendVia(to: string, body: string, customerId: string, sentBy?: string | null) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", to, body, customerId, purpose: "arrival", sentBy: sentBy || "Tech" }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d?.error) throw new Error(d?.error || `sms send failed (${r.status})`)
  return d
}

async function notifyArrival(stopId: string, sentBy?: string | null) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/route_stops?id=eq.${stopId}&select=id,arrival_notified_at,` +
      `properties(name,address,customer_id,customers(id,name,contact_name,phone,notify_on_service))`,
    { headers: rest },
  )
  const rows = await r.json()
  const stop = Array.isArray(rows) ? rows[0] : null
  if (!stop) return { ok: false, skipped: "stop_not_found" }
  if (stop.arrival_notified_at) return { ok: true, skipped: "already_notified" }

  const prop = stop.properties || {}
  const cust = prop.customers || null
  if (!cust) return { ok: true, skipped: "no_customer" }
  const phone = (cust.phone || "").trim()
  if (!phone) return { ok: true, skipped: "no_phone" }

  const override = cust.notify_on_service // true / false / null
  let send = false, reason = ""
  if (override === true) { send = true; reason = "override_on" }
  else if (override === false) { send = false; reason = "override_off" }
  else {
    const propCount = await countCustomerProperties(cust.id)
    if (propCount > 1) { send = false; reason = "multi_location" }
    else { send = true; reason = "single_property" }
  }
  if (!send) return { ok: true, skipped: reason }

  const claimed = await claimArrival(stopId)
  if (!claimed) return { ok: true, skipped: "already_notified" }

  const who = (cust.contact_name || cust.name || "there").trim()
  const where = (prop.address || prop.name || "your property").trim()
  const body = `Hi ${who}, your Valet Waste FL technician has arrived at ${where} and is servicing your property now. Thank you! — Valet Waste FL`

  try {
    const res = await sendVia(phone, body, cust.id, sentBy)
    return { ok: true, sent: true, reason, provider: res?.provider }
  } catch (e) {
    await releaseArrival(stopId)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })
  try {
    const { stopId, sentBy } = await req.json()
    if (!stopId) return json({ error: "A 'stopId' is required." }, 400)
    return json(await notifyArrival(String(stopId), sentBy))
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) })
  }
})
