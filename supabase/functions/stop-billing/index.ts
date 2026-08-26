// Per-stop invoice drafting — the billing side of the driver's check-in /
// check-out "Add to draft invoice?" popup (mig 0043).
//
//   action "draft_stop_line" { stopId, byName }
//
// Idempotent: invoice_line_items.stop_id has a unique index, so a stop can
// only ever land on one line item — check-in AND check-out popups can both
// say yes safely.
//
// Two shapes:
//  • ONE-TIME stop (route_stops.job_price / job_title set — junk removal etc.
//    added via Plan Routes): creates a fresh single-line draft invoice for the
//    stop's customer and schedules the invoice EMAIL to go out that evening
//    (~6pm America/New_York; if that's already past, ~30 min from now) via
//    invoice_scheduled_sends (0040). Staff can still edit/cancel in Invoices
//    before it fires.
//  • SUBSCRIPTION stop: appends one line ("Week 2 Fri Pick Up" — week-of-month
//    + weekday from routes.service_date) to the customer's current-month draft
//    invoice, at the property's per-pickup price. Same pattern the lawn cron
//    uses.
//
// Deploy with JWT verification OFF (clients call with the anon key):
//   supabase functions deploy stop-billing --no-verify-jwt

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

const enc = encodeURIComponent

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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`PATCH ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}

const money = (v: number) => `$${Number(v || 0).toFixed(2)}`

const WDAYS = ["Sun", "Mon", "Tues", "Wed", "Thurs", "Fri", "Sat"]

// "Week 2 Fri Pick Up" — David's line-item format for subscription stops.
function subscriptionTitle(serviceDate: string): string {
  const d = new Date(serviceDate + "T12:00:00Z")
  const week = Math.ceil(d.getUTCDate() / 7)
  return `Week ${week} ${WDAYS[d.getUTCDay()]} Pick Up`
}

// 6pm America/New_York today (ET), or ~30 min from now if that already passed.
function tonightEastern(): string {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  })
  const p: Record<string, string> = {}
  for (const { type, value } of fmt.formatToParts(now)) p[type] = value
  const h = Number(p.hour) % 24, m = Number(p.minute), s = Number(p.second)
  // "now" rendered as if ET were UTC, and the offset needed to get back to real UTC
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, m, s)
  const offset = asUtc - now.getTime()
  const sixPmEt = asUtc - h * 3600000 - m * 60000 - s * 1000 + 18 * 3600000
  const target = sixPmEt - offset
  return new Date(target > now.getTime() ? target : now.getTime() + 30 * 60000).toISOString()
}

async function logActivity(summary: string, customerId: string | null, invoiceId: string, propertyId: string | null, byName?: string | null) {
  try {
    await sbPost("activity_log", {
      type: "stop_invoiced", actor: byName || "System", summary,
      entity_type: "invoice", entity_id: invoiceId,
      meta: { customer_id: customerId, property_id: propertyId },
    })
  } catch (_e) { /* best effort */ }
}

async function draftStopLine(stopId: string, byName?: string | null) {
  const stop = (await sbGet(
    `route_stops?id=eq.${enc(stopId)}&select=id,service,job_title,job_description,job_price,` +
      `routes(service_date,business_line),properties(id,address,service,price,customer_id)`,
  ))[0]
  if (!stop) return { ok: false, error: "stop_not_found" }
  const prop = stop.properties || {}
  if (!prop.customer_id) return { ok: false, error: "no_customer", detail: "This stop isn't tied to a customer." }

  // Idempotency guard — the unique index would reject anyway; check first for
  // a clean message.
  const dup = await sbGet(`invoice_line_items?stop_id=eq.${enc(stopId)}&select=id,invoice_id&limit=1`)
  if (dup.length) {
    const inv = (await sbGet(`invoices?id=eq.${dup[0].invoice_id}&select=number`))[0]
    return { ok: true, skipped: "already_invoiced", invoice: inv?.number }
  }

  const isOneTime = stop.job_price != null || stop.job_title != null
  let title: string, description: string, price: number

  if (isOneTime) {
    title = (stop.job_title || "").trim() || "One-time service"
    description = (stop.job_description || "").trim() || (prop.service || stop.service || "One-off pickup")
    price = Number(stop.job_price != null ? stop.job_price : prop.price)
    if (!(price > 0)) {
      return { ok: false, error: "no_price", detail: "This one-time stop has no price set — add one in Plan Routes." }
    }
  } else {
    title = subscriptionTitle(String(stop.routes?.service_date || new Date().toISOString().slice(0, 10)))
    description = [prop.service || stop.service, prop.address].filter(Boolean).join(" — ") || "Service visit"
    price = Number(prop.price)
    if (!(price > 0)) {
      return { ok: false, error: "no_price", detail: "This property has no per-pickup price set." }
    }
  }

  let invoice: Record<string, any>
  if (isOneTime) {
    // Fresh single-line draft, scheduled to email out this evening.
    invoice = (await sbPost("invoices", {
      customer_id: prop.customer_id, status: "draft", subtotal: price, total: price, discount: 0,
    }))[0]
  } else {
    // Append to the customer's current-month draft (lawn-cron pattern).
    const monthStart = new Date().toISOString().slice(0, 8) + "01"
    invoice = (await sbGet(
      `invoices?customer_id=eq.${prop.customer_id}&status=eq.draft&created_at=gte.${monthStart}` +
      `&select=id,number,subtotal,discount&order=created_at.desc&limit=1`,
    ))[0]
    if (!invoice) {
      invoice = (await sbPost("invoices", { customer_id: prop.customer_id, status: "draft", subtotal: 0, total: 0, discount: 0 }))[0]
    }
  }

  const last = await sbGet(`invoice_line_items?invoice_id=eq.${invoice.id}&select=position&order=position.desc.nullslast&limit=1`)
  await sbPost("invoice_line_items", {
    invoice_id: invoice.id, stop_id: stop.id,
    title, description, quantity: 1,
    unit_price: price, amount: price, position: ((last[0]?.position ?? -1) + 1),
  })

  if (isOneTime) {
    await sbPost("invoice_scheduled_sends", {
      invoice_id: invoice.id, channel: "email", send_at: tonightEastern(), status: "pending",
    })
  } else {
    const subtotal = Number(invoice.subtotal || 0) + price
    await sbPatch(`invoices?id=eq.${invoice.id}`, { subtotal, total: Math.max(0, subtotal - Number(invoice.discount || 0)) })
  }

  await logActivity(
    isOneTime
      ? `One-time job invoiced — ${title} (${money(price)}) on draft ${invoice.number}, email scheduled for tonight`
      : `Invoiced ${title} at ${prop.address || "property"} — ${money(price)} added to draft ${invoice.number}`,
    prop.customer_id, invoice.id, prop.id, byName,
  )

  return {
    ok: true, added: true, one_time: isOneTime,
    invoice: invoice.number, title, price,
    scheduled_email: isOneTime ? "tonight" : null,
    by: byName || null,
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })
  try {
    const { action, stopId, byName } = await req.json()
    if (action !== "draft_stop_line") return json({ error: "Unknown action." }, 400)
    if (!stopId) return json({ error: "A 'stopId' is required." }, 400)
    return json(await draftStopLine(String(stopId), byName))
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) })
  }
})
