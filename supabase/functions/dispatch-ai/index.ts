// Trashy Randy — dispatch AI assistant (Supabase Edge Function).
//
// Holds the Anthropic API key server-side (never exposed to the browser) and
// runs an agentic tool-use loop against the CRM's Postgres (via PostgREST with
// the service-role key). It can look things up and make operational changes:
// clients, pickup schedules, invoices, tags, and route stops.
//
// Secrets required (set in Supabase, NOT in the frontend):
//   ANTHROPIC_API_KEY   - your Anthropic key
//   ANTHROPIC_MODEL     - optional, defaults to claude-sonnet-4-6
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6"
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
const FREQS = ["weekly", "biweekly", "monthly", "1st_3rd", "2nd_4th", "on_call"]
const CADENCES = ["monthly", "per_service", "weekly", "quarterly", "annual"]

const SYSTEM = `You are Trashy Randy, the dispatch assistant inside Valet Waste, a CRM for a waste-hauling business. You help manage clients, pickup schedules, invoices, tags, and routes. Be concise and operational (1-3 sentences).

Guidelines:
- When the user refers to a client by name, business, phone or email, call find_clients FIRST to resolve the exact customer_id before acting. If multiple match, ask which one. If none match and the action needs an existing client, say so.
- Infer sensible defaults: weekly pickup on Monday, monthly invoicing. Invoices are created as drafts unless told otherwise.
- You can create_client, update_client, create_schedule (pickup), tag_client, create_invoice, mark_invoice_paid, and add_stop_to_route. Use get_overview to answer questions about outstanding balance, today's pickups, or counts.
- You cannot send payment links or charge cards — tell the user to use the "Send payment link" button on the invoice for that.
- After making a change, confirm what you did in one short sentence.`

const tools = [
  {
    name: "find_clients",
    description: "Search customers by name, business, email, phone or address. Returns matches with ids. Use this to resolve who the user means before acting, or to answer questions about a client's contact info.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Name, email, phone or address fragment" } },
      required: ["query"],
    },
  },
  {
    name: "get_overview",
    description: "Get a snapshot of the business: client counts, today's scheduled pickups, outstanding (sent) and collected (paid) invoice totals, and draft count.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_client",
    description: "Create a new customer with a pickup schedule and an invoice schedule.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Business / client name" },
        address: { type: "string" },
        contact_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        service: { type: "string", description: 'e.g. "4yd dumpster x2"' },
        pickup_frequency: { type: "string", enum: FREQS },
        pickup_day: { type: "string", enum: DAYS },
        invoice_cadence: { type: "string", enum: CADENCES },
        invoice_amount: { type: "number", description: "Recurring rate in dollars (optional)" },
        status: { type: "string", enum: ["active", "paused", "prospect"] },
      },
      required: ["name"],
    },
  },
  {
    name: "update_client",
    description: "Update an existing customer's contact details, status or notes. Only provided fields change.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        name: { type: "string" },
        address: { type: "string" },
        contact_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        notes: { type: "string" },
        status: { type: "string", enum: ["active", "paused", "prospect"] },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "create_schedule",
    description: "Add a recurring pickup schedule to an existing customer.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        service: { type: "string" },
        frequency: { type: "string", enum: FREQS },
        day: { type: "string", enum: DAYS },
        start_date: { type: "string", description: "YYYY-MM-DD (optional)" },
        active: { type: "boolean" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "tag_client",
    description: "Attach a tag to a customer (creating the tag if it doesn't exist). Useful for grouping by area, service type, priority, etc.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        tag: { type: "string", description: "Tag label" },
        color: { type: "string", description: "Hex color like #1f7a4d (optional)" },
      },
      required: ["customer_id", "tag"],
    },
  },
  {
    name: "create_invoice",
    description: "Create an invoice (draft by default) for a customer with line items. Totals are computed automatically.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        line_items: {
          type: "array",
          description: "Line items on the invoice",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unit_price: { type: "number", description: "Per-unit price in dollars" },
            },
            required: ["description", "unit_price"],
          },
        },
        discount: { type: "number", description: "Flat dollar discount (optional)" },
        due_date: { type: "string", description: "YYYY-MM-DD (optional)" },
        notes: { type: "string" },
        status: { type: "string", enum: ["draft", "sent"], description: "Defaults to draft" },
      },
      required: ["customer_id", "line_items"],
    },
  },
  {
    name: "mark_invoice_paid",
    description: "Mark an invoice as paid. Accepts an invoice number (e.g. INV-1001) or invoice id.",
    input_schema: {
      type: "object",
      properties: { invoice: { type: "string", description: "Invoice number or id" } },
      required: ["invoice"],
    },
  },
  {
    name: "add_stop_to_route",
    description: "Add an address as a stop on a route. Finds or creates the property and the route (by code, e.g. 'B'), geocodes the address, and appends the stop.",
    input_schema: {
      type: "object",
      properties: {
        route_code: { type: "string", description: "Route code/letter, e.g. 'B'. Defaults to 'B'." },
        property_name: { type: "string", description: "Name/label for the stop" },
        address: { type: "string" },
        service: { type: "string" },
      },
      required: ["address"],
    },
  },
]

// ---- PostgREST helpers (service role) ----
const REST = `${SUPABASE_URL}/rest/v1`
const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}

async function sbGet(path: string) {
  const r = await fetch(`${REST}/${path}`, { headers: HEADERS })
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}
async function sbPost(path: string, body: unknown) {
  const r = await fetch(`${REST}/${path}`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}
async function sbPatch(path: string, body: unknown) {
  const r = await fetch(`${REST}/${path}`, {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`PATCH ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}

const enc = encodeURIComponent
const round2 = (v: number) => Math.round(v * 100) / 100

async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${enc(address)}`,
      { headers: { "User-Agent": "ValetWasteCRM/1.0 (dispatch-ai)" } },
    )
    if (!r.ok) return null
    const rows = await r.json()
    if (!rows?.length) return null
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lon) }
  } catch {
    return null
  }
}

// ---- tool implementations ----
async function findClients(a: any) {
  const q = String(a.query ?? "").trim()
  if (!q) return { matches: [] }
  const like = `*${q}*`
  const or = `or=(name.ilike.${enc(like)},email.ilike.${enc(like)},phone.ilike.${enc(like)},contact_name.ilike.${enc(like)},address.ilike.${enc(like)})`
  const rows = await sbGet(`customers?${or}&select=id,name,contact_name,email,phone,address,status&limit=10`)
  return { matches: rows }
}

async function getOverview() {
  const customers = await sbGet(`customers?select=id,status`)
  const schedules = await sbGet(`pickup_schedules?select=day_of_week,active,frequency`)
  const invoices = await sbGet(`invoices?select=status,total`)
  const todayDow = DAYS[(new Date().getDay() + 6) % 7] // JS Sun=0 -> our mon-indexed list
  const todayPickups = schedules.filter((s: any) => s.active !== false && s.day_of_week === todayDow).length
  const sum = (st: string) =>
    round2(invoices.filter((i: any) => i.status === st).reduce((x: number, i: any) => x + Number(i.total || 0), 0))
  return {
    clients_total: customers.length,
    clients_active: customers.filter((c: any) => c.status === "active").length,
    today: todayDow,
    today_pickups: todayPickups,
    outstanding: sum("sent"),
    collected: sum("paid"),
    drafts: invoices.filter((i: any) => i.status === "draft").length,
  }
}

async function createClient(a: any) {
  const [customer] = await sbPost("customers", {
    name: a.name,
    address: a.address ?? null,
    contact_name: a.contact_name ?? null,
    email: a.email ?? null,
    phone: a.phone ?? null,
    status: a.status ?? "active",
  })
  await sbPost("pickup_schedules", {
    customer_id: customer.id,
    service: a.service ?? null,
    frequency: a.pickup_frequency ?? "weekly",
    day_of_week: a.pickup_frequency === "on_call" ? null : (a.pickup_day ?? "monday"),
  })
  await sbPost("invoice_schedules", {
    customer_id: customer.id,
    cadence: a.invoice_cadence ?? "monthly",
    amount: a.invoice_amount ?? null,
  })
  return { id: customer.id, name: customer.name }
}

async function updateClient(a: any) {
  const patch: Record<string, unknown> = {}
  for (const k of ["name", "address", "contact_name", "email", "phone", "notes", "status"]) {
    if (a[k] !== undefined) patch[k] = a[k]
  }
  if (Object.keys(patch).length === 0) throw new Error("No fields to update.")
  const [row] = await sbPatch(`customers?id=eq.${enc(a.customer_id)}`, patch)
  if (!row) throw new Error("Customer not found.")
  return { id: row.id, name: row.name, updated: Object.keys(patch) }
}

async function createSchedule(a: any) {
  const [row] = await sbPost("pickup_schedules", {
    customer_id: a.customer_id,
    service: a.service ?? null,
    frequency: a.frequency ?? "weekly",
    day_of_week: a.frequency === "on_call" ? null : (a.day ?? "monday"),
    start_date: a.start_date ?? null,
    active: a.active ?? true,
  })
  return { id: row.id, frequency: row.frequency, day: row.day_of_week }
}

async function tagClient(a: any) {
  const name = String(a.tag ?? "").trim()
  if (!name) throw new Error("Tag label required.")
  const existing = await sbGet(`tags?name=ilike.${enc(name)}&select=id,name,color&limit=1`)
  let tag = existing[0]
  if (!tag) {
    const [created] = await sbPost("tags", { name, color: a.color ?? "#1f7a4d" })
    tag = created
  }
  // Upsert junction (ignore duplicate)
  await fetch(`${REST}/customer_tags`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({ customer_id: a.customer_id, tag_id: tag.id }),
  })
  return { tag: tag.name, customer_id: a.customer_id }
}

async function createInvoice(a: any) {
  const items = (a.line_items ?? []).map((it: any) => {
    const qty = Number(it.quantity ?? 1) || 1
    const price = Number(it.unit_price ?? 0)
    return { description: it.description ?? null, quantity: qty, unit_price: price, amount: round2(qty * price) }
  })
  const subtotal = round2(items.reduce((s: number, it: any) => s + it.amount, 0))
  const discount = Number(a.discount ?? 0)
  const total = round2(Math.max(0, subtotal - discount))
  const [inv] = await sbPost("invoices", {
    customer_id: a.customer_id,
    status: a.status ?? "draft",
    due_date: a.due_date ?? null,
    notes: a.notes ?? null,
    discount,
    subtotal,
    total,
  })
  if (items.length) {
    await sbPost("invoice_line_items", items.map((it: any, i: number) => ({ ...it, invoice_id: inv.id, position: i })))
  }
  return { id: inv.id, number: inv.number, total, status: inv.status }
}

async function markInvoicePaid(a: any) {
  const ref = String(a.invoice ?? "").trim()
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref)
  const filter = isUuid ? `id=eq.${enc(ref)}` : `number=eq.${enc(ref)}`
  const [row] = await sbPatch(`invoices?${filter}`, { status: "paid", paid_at: new Date().toISOString() })
  if (!row) throw new Error(`Invoice "${ref}" not found.`)
  return { number: row.number, status: row.status }
}

async function addStopToRoute(a: any) {
  const code = String(a.route_code ?? "B").trim() || "B"
  // route by code (create if missing)
  let routes = await sbGet(`routes?code=eq.${enc(code)}&select=id,code,name&limit=1`)
  let route = routes[0]
  if (!route) {
    const [r] = await sbPost("routes", { code, name: `Route ${code}` })
    route = r
  }
  // property by address (create if missing) — geocode best-effort
  const address = String(a.address ?? "").trim()
  let props = await sbGet(`properties?address=ilike.${enc(`*${address}*`)}&select=id,name,address,service,lat,lng&limit=1`)
  let property = props[0]
  if (!property) {
    const loc = await geocode(address)
    const [p] = await sbPost("properties", {
      name: a.property_name ?? address,
      address,
      service: a.service ?? null,
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
    })
    property = p
  }
  // next seq on the route
  const stops = await sbGet(`route_stops?route_id=eq.${enc(route.id)}&select=seq&order=seq.desc&limit=1`)
  const nextSeq = (stops[0]?.seq ?? 0) + 1
  const [stop] = await sbPost("route_stops", {
    route_id: route.id,
    property_id: property.id,
    seq: nextSeq,
    status: "pending",
    service: a.service ?? property.service ?? null,
    lat: property.lat ?? null,
    lng: property.lng ?? null,
  })
  return { route: route.code, stop_name: property.name, seq: stop.seq }
}

async function runTool(name: string, input: any): Promise<unknown> {
  switch (name) {
    case "find_clients": return await findClients(input)
    case "get_overview": return await getOverview()
    case "create_client": return await createClient(input)
    case "update_client": return await updateClient(input)
    case "create_schedule": return await createSchedule(input)
    case "tag_client": return await tagClient(input)
    case "create_invoice": return await createInvoice(input)
    case "mark_invoice_paid": return await markInvoicePaid(input)
    case "add_stop_to_route": return await addStopToRoute(input)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

async function callAnthropic(messages: unknown[], apiKey: string) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages }),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`)
  return data
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
    if (!apiKey) {
      return json({
        text: "I'm not connected yet — the ANTHROPIC_API_KEY secret hasn't been set in Supabase. Once it's added I can start helping.",
        actions: [],
      })
    }

    const { messages: incoming } = await req.json()
    const messages: any[] = (incoming || [])
      .filter((m: any) => m && m.text)
      .map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }))

    const actions: Array<{ tool: string; result: unknown }> = []
    let finalText = ""

    for (let i = 0; i < 8; i++) {
      const res = await callAnthropic(messages, apiKey)
      finalText = (res.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim()

      if (res.stop_reason !== "tool_use") break

      messages.push({ role: "assistant", content: res.content })
      const results = []
      for (const block of res.content) {
        if (block.type !== "tool_use") continue
        try {
          const out = await runTool(block.name, block.input)
          if (block.name !== "find_clients" && block.name !== "get_overview") {
            actions.push({ tool: block.name, result: out })
          }
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) })
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e instanceof Error ? e.message : String(e)}`, is_error: true })
        }
      }
      messages.push({ role: "user", content: results })
    }

    return json({ text: finalText || "Done.", actions })
  } catch (e) {
    return json({ text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, actions: [] }, 200)
  }
})
