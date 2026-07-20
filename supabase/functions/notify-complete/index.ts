// Service-complete notification — "your service is complete."
//
// Fired when a tech marks a stop complete (check-out). This is OPT-IN: it only
// sends when app_settings.notify_on_complete is TRUE (Randy turns it on in
// Settings, or Trashy Randy flips it via chat/SMS). When on, it reuses the SAME
// per-contact suppression as the arrival text, so multi-location property
// managers are still auto-skipped unless they have an override.
//
//   app_settings.notify_on_complete:  master on/off (default false)
//   customers.notify_on_service:       TRUE=always, FALSE=never, NULL=auto
//   route_stops.complete_notified_at:  atomic at-most-once guard per stop.
//
// Wording comes from app_settings.sms_checkout_template (editable in Settings).
// The SMS goes out through the existing `sms` function's `send` action.
//
// Deploy with JWT verification OFF (clients call with the anon key):
//   supabase functions deploy notify-complete --no-verify-jwt

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

const DEFAULT_TPL = "Hi {customerName}, your {serviceType} service at {address} is complete. Thank you for choosing {companyName}!"

async function getSettings(): Promise<Record<string, unknown>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=notify_on_complete,sms_checkout_template,company_name`, { headers: rest })
  const rows = await r.json()
  return Array.isArray(rows) ? (rows[0] || {}) : {}
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

// Flip complete_notified_at NULL→now. Returns true only for the winning caller.
async function claimComplete(stopId: string): Promise<boolean> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/route_stops?id=eq.${stopId}&complete_notified_at=is.null`,
    { method: "PATCH", headers: { ...rest, Prefer: "return=representation" },
      body: JSON.stringify({ complete_notified_at: new Date().toISOString() }) },
  )
  const rows = await r.json()
  return Array.isArray(rows) && rows.length > 0
}
async function releaseComplete(stopId: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/route_stops?id=eq.${stopId}`, {
      method: "PATCH", headers: rest, body: JSON.stringify({ complete_notified_at: null }),
    })
  } catch (_e) { /* best effort */ }
}

async function sendVia(to: string, body: string, customerId: string, sentBy?: string | null) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", to, body, customerId, purpose: "complete", sentBy: sentBy || "Tech" }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d?.error) throw new Error(d?.error || `sms send failed (${r.status})`)
  return d
}

function render(tpl: string, vars: Record<string, string>): string {
  return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m))
}

async function notifyComplete(stopId: string, sentBy?: string | null) {
  const settings = await getSettings()
  if (!settings.notify_on_complete) return { ok: true, skipped: "disabled" }

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/route_stops?id=eq.${stopId}&select=id,service,complete_notified_at,` +
      `properties(name,address,service,customer_id,customers(id,name,contact_name,phone,notify_on_service))`,
    { headers: rest },
  )
  const rows = await r.json()
  const stop = Array.isArray(rows) ? rows[0] : null
  if (!stop) return { ok: false, skipped: "stop_not_found" }
  if (stop.complete_notified_at) return { ok: true, skipped: "already_notified" }

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

  const claimed = await claimComplete(stopId)
  if (!claimed) return { ok: true, skipped: "already_notified" }

  const body = render(String(settings.sms_checkout_template || DEFAULT_TPL), {
    customerName: (cust.contact_name || cust.name || "there").trim(),
    serviceType: (prop.service || stop.service || "trash").trim(),
    address: (prop.address || prop.name || "your property").trim(),
    companyName: (String(settings.company_name || "").trim() || "Valet Waste FL"),
  })

  try {
    const res = await sendVia(phone, body, cust.id, sentBy)
    return { ok: true, sent: true, reason, provider: res?.provider }
  } catch (e) {
    await releaseComplete(stopId)
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
    return json(await notifyComplete(String(stopId), sentBy))
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) })
  }
})
