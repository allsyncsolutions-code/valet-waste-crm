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
- You can create_client, update_client, create_schedule (pickup), tag_client, create_invoice, mark_invoice_paid, add_stop_to_route, assemble_route, move_stops, assign_driver, list_routes, and create_route. Use get_overview for balances/counts and list_routes to see which routes exist.
- Routes are per DAY and there can be several (e.g. Route A, B). Every route op defaults to TODAY and to the first route unless the user names a date or a route. If more than one route exists and it's ambiguous which they mean, call list_routes and ask.
- assemble_route adds EXISTING properties to a route by selector: by_customer (name), by_tag, or address_contains — e.g. "build Route B today from everything tagged North Side" or "add all of Acme's stops to Route A". add_stop_to_route is for ONE brand-new address (it creates the property). bulk_add_properties imports many NEW addresses for one client.
- move_stops moves matching stops from one route to another on a date (from_route_code → to_route_code), which hands them to the other route's driver. Pick which stops by_customer or address_contains.
- assign_driver assigns (or unassigns) a driver for a route on a date; the driver must be flagged in the Team tab. set_default:true makes them the route's default. create_route adds a new route (code + name).
- When the user gives you MORE THAN ONE property/address for the same client (a pasted list, a vendor sheet, etc.), use bulk_add_properties ONCE with all of them — do not call add_stop_to_route in a loop. Pass every row in the properties array and report how many were added.
- Staff flag uncertain imported properties as "Needs review" (e.g. unclear pricing or pickup frequency). Use list_needs_review to report what's flagged ("what needs review?"). Use edit_property to fix ONE property the owner is reviewing — set price/service/pickup_days/notes — and pass mark_reviewed:true to clear the flag once it's right. Find the property by address (add client_name if the address is ambiguous); if edit_property returns needs_clarification, ask the user which match they mean.
- Use flag_properties to flag or unflag MANY properties at once by client, tag, or address (e.g. "flag everything for Staylah for review" → by_customer:"Staylah"; "clear review on all Palm Coast properties" → address_contains:"Palm Coast", needs_review:false). It defaults to flagging; pass needs_review:false to clear.
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
    description: "Add ONE new address as a stop on a route for a date. Finds or creates the property, geocodes the address, and appends the stop. Defaults to today and the first route.",
    input_schema: {
      type: "object",
      properties: {
        route_code: { type: "string", description: "Route code/letter. Defaults to the first route." },
        date: { type: "string", description: "Service date YYYY-MM-DD. Defaults to today." },
        property_name: { type: "string", description: "Name/label for the stop" },
        address: { type: "string" },
        service: { type: "string" },
      },
      required: ["address"],
    },
  },
  {
    name: "list_routes",
    description: "List the routes the business runs (codes, names, default drivers). Use this to see what routes exist before assigning, assembling, or moving.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_route",
    description: "Create a new route in the catalog (e.g. code 'C', name 'North Side'). Use when the user wants a brand-new route.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Short route code, e.g. 'C'." },
        name: { type: "string", description: "Display name (optional)." },
      },
      required: ["code"],
    },
  },
  {
    name: "assemble_route",
    description: "Put a route together by adding EXISTING service properties to it for a date, selected by customer, tag, or address text. Provide at least one selector. Defaults to today and the first route.",
    input_schema: {
      type: "object",
      properties: {
        route_code: { type: "string", description: "Target route code. Defaults to the first route." },
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
        by_customer: { type: "string", description: "Customer/business name — adds all of that customer's properties." },
        by_tag: { type: "string", description: "Tag name — adds properties of customers carrying this tag." },
        address_contains: { type: "string", description: "Match properties whose address or name contains this text (e.g. a city or street)." },
      },
      required: [],
    },
  },
  {
    name: "move_stops",
    description: "Move matching stops from one route to another on a date — this hands them to the destination route's driver. Select which stops by customer or address.",
    input_schema: {
      type: "object",
      properties: {
        from_route_code: { type: "string", description: "Route to move stops OFF of." },
        to_route_code: { type: "string", description: "Route to move stops ONTO." },
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
        by_customer: { type: "string", description: "Customer/business name." },
        address_contains: { type: "string", description: "Match by address/name text." },
      },
      required: ["from_route_code", "to_route_code"],
    },
  },
  {
    name: "assign_driver",
    description:
      "Assign (or unassign) the driver for a route on a specific date. The driver must be a staff member flagged as a driver in the Team tab. Optionally set them as the carry-forward default for that route code, which auto-applies to newly built days.",
    input_schema: {
      type: "object",
      properties: {
        driver: { type: "string", description: "Driver's name or email. Use 'none' (or set unassign:true) to clear the driver." },
        unassign: { type: "boolean", description: "Set true to remove the current driver from the route." },
        route_code: { type: "string", description: "Route code/letter. Defaults to the first route." },
        date: { type: "string", description: "Service date YYYY-MM-DD. Defaults to today." },
        set_default: { type: "boolean", description: "If true, remember this driver as the default for the route code (auto-assigned to new days)." },
      },
      required: [],
    },
  },
  {
    name: "bulk_add_properties",
    description:
      "Add MANY service properties for one client in a single call. Use this whenever the user pastes or lists more than one address/location for the same client (e.g. a vendor property list) — never loop add_stop_to_route for each. Resolves the client by name (creates it if new), batch-inserts every property, and optionally sets up one pickup schedule. Coordinates are filled in afterward by the geocoder, so you don't geocode here.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "The client/company that owns these properties. Created if it doesn't exist." },
        client_id: { type: "string", description: "Use instead of client_name if you already resolved the customer id via find_clients." },
        default_service: { type: "string", description: "Service for properties that don't specify their own, e.g. 'Trash / Recycle'." },
        price: { type: "number", description: "Price per property (e.g. 11 for $11/week). Applied to every property." },
        create_schedule: { type: "boolean", description: "If true, create one pickup schedule for the client." },
        pickup_day: { type: "string", description: "Pickup day if create_schedule, e.g. 'monday'. Defaults to monday." },
        pickup_freq: { type: "string", description: "weekly | biweekly | monthly | on_call. Defaults to weekly." },
        properties: {
          type: "array",
          description: "Every property to add.",
          items: {
            type: "object",
            properties: {
              code: { type: "string", description: "Short code from the source list, optional." },
              name: { type: "string", description: "Label; defaults to the address if omitted." },
              address: { type: "string", description: "Full street address incl. city/zip for geocoding." },
              service: { type: "string", description: "Per-property service; falls back to default_service." },
              notes: { type: "string", description: "Bin placement / access note, optional." },
            },
            required: ["address"],
          },
        },
      },
      required: ["properties"],
    },
  },
  {
    name: "list_needs_review",
    description:
      "List properties flagged 'Needs review'. Staff flag messy/uncertain imports (e.g. unclear pricing or frequency) so the owner can go over them. Returns each flagged property with its client, address, price, service, and pickup days. Use this when the user asks what needs review / what needs fixing / what's flagged. Optionally narrow to one client.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Optional — only show flagged properties for this client." },
      },
    },
  },
  {
    name: "edit_property",
    description:
      "Edit ONE existing property and/or clear its 'Needs review' flag. Find it by address (and optionally the client name to disambiguate). Use this to fix a flagged property the owner is reviewing — set the price, service, pickup day(s), or notes, and set mark_reviewed:true to clear the flag once it's correct. Set needs_review:true to flag a property for review.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address (or part of it) of the property to edit. Required unless property_id is given." },
        property_id: { type: "string", description: "Exact property id, if known. Use instead of address." },
        client_name: { type: "string", description: "Optional — the owning client, to disambiguate a shared address." },
        price: { type: "number", description: "New price for this property." },
        service: { type: "string", description: "New service, e.g. 'Trash / Recycle'." },
        notes: { type: "string", description: "New bin-placement / access note." },
        pickup_days: { type: "array", items: { type: "string" }, description: "Full lowercase day names, e.g. ['monday','thursday']. Replaces the property's pickup days." },
        pickup_freq: { type: "string", description: "weekly | biweekly | monthly | on_call." },
        mark_reviewed: { type: "boolean", description: "True to clear the Needs review flag (property is now correct)." },
        needs_review: { type: "boolean", description: "True to flag this property for review. Ignored if mark_reviewed is set." },
      },
    },
  },
  {
    name: "flag_properties",
    description:
      "Flag (or unflag) MANY existing properties for review in one shot, selected by client, tag, or address text. Use for bulk review actions like 'flag everything for Staylah for review' or 'clear the review flag on all Palm Coast properties'. To change or clear a SINGLE property's details, use edit_property instead. Provide at least one selector.",
    input_schema: {
      type: "object",
      properties: {
        by_customer: { type: "string", description: "Client/business name — affects all of that client's properties." },
        by_tag: { type: "string", description: "Tag name — affects properties of clients carrying this tag." },
        address_contains: { type: "string", description: "Match properties whose address or name contains this text (e.g. a city or street)." },
        needs_review: { type: "boolean", description: "True to flag for review (default), false to clear the flag." },
      },
      required: [],
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

// Best-effort activity logging (actor = Trashy Randy). Never throws.
async function logActivity(type: string, summary: string, entityType?: string, entityId?: string) {
  try {
    await sbPost("activity_log", {
      type,
      actor: "Trashy Randy",
      summary,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
    })
  } catch (_) { /* logging is non-critical */ }
}

function logForTool(name: string, out: any): Promise<void> | undefined {
  switch (name) {
    case "create_client": return logActivity("client_created", `Added client ${out.name}`, "customer", out.id)
    case "update_client": return logActivity("client_updated", `Updated client ${out.name}`, "customer", out.id)
    case "create_schedule": return logActivity("schedule_created", `Added a ${out.frequency} pickup`, "schedule", out.id)
    case "tag_client": return logActivity("client_tagged", `Tagged a client "${out.tag}"`, "customer", out.customer_id)
    case "create_invoice": return logActivity("invoice_created", `Created invoice ${out.number} ($${out.total})`, "invoice", out.id)
    case "mark_invoice_paid": return logActivity("invoice_paid", `Marked invoice ${out.number} paid`, "invoice")
    case "add_stop_to_route": return logActivity("stop_added", `Added ${out.stop_name} to route ${out.route}`, "route")
    case "assign_driver": return out.needs_clarification ? undefined : logActivity("driver_assigned", `Set ${out.driver} as driver for route ${out.route} (${out.date})`, "route")
    case "create_route": return logActivity("route_created", `Created route ${out.code} (${out.name})`, "route")
    case "assemble_route": return out.added ? logActivity("route_assembled", `Added ${out.added} stop${out.added === 1 ? "" : "s"} to route ${out.route} (${out.date})`, "route") : undefined
    case "move_stops": return out.moved ? logActivity("stops_moved", `Moved ${out.moved} stop${out.moved === 1 ? "" : "s"} ${out.from}→${out.to} (${out.date})`, "route") : undefined
    case "bulk_add_properties": return logActivity("properties_imported", `Imported ${out.inserted} properties for ${out.client}`, "customer", out.customer_id)
    case "edit_property": return out.needs_clarification ? undefined : logActivity("property_updated", `Updated property ${out.address}${out.needs_review === false ? " (reviewed)" : ""}`, "property", out.id)
    case "flag_properties": return out.changed ? logActivity("properties_flagged", `${out.needs_review ? "Flagged" : "Cleared review on"} ${out.changed} propert${out.changed === 1 ? "y" : "ies"}`, "customer") : undefined
    default: return undefined
  }
}

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

// ---- multi-route helpers (mirror the frontend's date-aware model) ----
const today = () => new Date().toISOString().slice(0, 10)

async function driverName(id: string | null): Promise<string | null> {
  if (!id) return null
  const r = await sbGet(`profiles?id=eq.${enc(id)}&select=full_name,email`)
  return r[0] ? (r[0].full_name || r[0].email || null) : null
}

// First route in the catalog (used when the user doesn't name one).
async function defaultRouteCode(): Promise<string> {
  const r = await sbGet(`route_defaults?active=eq.true&select=code&order=sort.asc,code.asc&limit=1`)
  return r[0]?.code || "A"
}

// Get-or-create the routes row for code+date, applying the catalog default driver.
async function ensureRoute(code: string, date?: string) {
  const d = date || today()
  const found = await sbGet(`routes?code=eq.${enc(code)}&service_date=eq.${enc(d)}&select=id,code&limit=1`)
  if (found[0]) return found[0]
  const def = await sbGet(`route_defaults?code=eq.${enc(code)}&select=driver_id,name`)
  const drvId = def[0]?.driver_id || null
  const [r] = await sbPost("routes", {
    code, name: def[0]?.name || `Route ${code}`, service_date: d,
    driver_id: drvId, driver: await driverName(drvId),
  })
  return r
}

// Resolve a set of existing property ids from selectors (union when several given).
async function resolvePropertyIds(a: any): Promise<string[]> {
  const ids = new Set<string>()
  const addFrom = async (path: string) => {
    const rows = await sbGet(path)
    for (const r of rows) ids.add(r.id)
  }
  if (a.by_customer_id) {
    await addFrom(`properties?customer_id=eq.${enc(a.by_customer_id)}&select=id`)
  } else if (a.by_customer) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${a.by_customer}*`)}&select=id&limit=25`)
    if (custs.length) await addFrom(`properties?customer_id=in.(${custs.map((c: any) => c.id).join(",")})&select=id`)
  }
  if (a.by_tag) {
    const tags = await sbGet(`tags?name=ilike.${enc(`*${a.by_tag}*`)}&select=id&limit=5`)
    if (tags.length) {
      const cts = await sbGet(`customer_tags?tag_id=in.(${tags.map((t: any) => t.id).join(",")})&select=customer_id`)
      const custIds = [...new Set(cts.map((c: any) => c.customer_id))]
      if (custIds.length) await addFrom(`properties?customer_id=in.(${custIds.join(",")})&select=id`)
    }
  }
  if (a.address_contains) {
    const like = enc(`*${a.address_contains}*`)
    await addFrom(`properties?or=(address.ilike.${like},name.ilike.${like})&select=id`)
  }
  return [...ids]
}

const nextSeqFrom = (rows: any[]) => rows.reduce((m: number, e: any) => Math.max(m, e.seq || 0), 0)

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
  const code = String(a.route_code ?? "").trim().toUpperCase() || await defaultRouteCode()
  const date = a.date ? String(a.date).trim() : today()
  const route = await ensureRoute(code, date)
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
  return { route: code, date, stop_name: property.name, seq: stop.seq }
}

async function listRoutes() {
  const defs = await sbGet(`route_defaults?active=eq.true&select=code,name,driver_id&order=sort.asc,code.asc`)
  const routes = []
  for (const d of defs) routes.push({ code: d.code, name: d.name || `Route ${d.code}`, default_driver: await driverName(d.driver_id) })
  return { routes }
}

async function createRoute(a: any) {
  const code = String(a.code ?? "").trim().toUpperCase()
  if (!code) throw new Error("A route code is required.")
  const name = (a.name && String(a.name).trim()) || `Route ${code}`
  const r = await fetch(`${REST}/route_defaults?on_conflict=code`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ code, name }),
  })
  if (!r.ok) throw new Error(`create_route: ${r.status} ${await r.text()}`)
  return { code, name }
}

async function assembleRoute(a: any) {
  const code = String(a.route_code ?? "").trim().toUpperCase() || await defaultRouteCode()
  const date = a.date ? String(a.date).trim() : today()
  if (!a.by_customer && !a.by_customer_id && !a.by_tag && !a.address_contains) {
    throw new Error("Tell me which properties to add — by customer, tag, or address.")
  }
  const propIds = await resolvePropertyIds(a)
  if (!propIds.length) return { route: code, date, matched: 0, added: 0 }
  const props = await sbGet(`properties?id=in.(${propIds.join(",")})&select=id,service,lat,lng`)
  const route = await ensureRoute(code, date)
  const existing = await sbGet(`route_stops?route_id=eq.${enc(route.id)}&select=property_id,seq`)
  const have = new Set(existing.map((e: any) => e.property_id))
  let seq = nextSeqFrom(existing)
  const rows = props.filter((p: any) => !have.has(p.id)).map((p: any) => ({
    route_id: route.id, property_id: p.id, seq: ++seq, status: "pending",
    service: p.service ?? null, lat: p.lat, lng: p.lng,
  }))
  if (rows.length) await sbPost("route_stops", rows)
  return { route: code, date, matched: props.length, added: rows.length }
}

async function moveStops(a: any) {
  const from = String(a.from_route_code ?? "").trim().toUpperCase()
  const to = String(a.to_route_code ?? "").trim().toUpperCase()
  const date = a.date ? String(a.date).trim() : today()
  if (!from || !to) throw new Error("Specify from_route_code and to_route_code.")
  if (from === to) throw new Error("The from and to routes are the same.")
  if (!a.by_customer && !a.by_customer_id && !a.address_contains) {
    throw new Error("Tell me which stops to move — by customer or address.")
  }
  const fromRoutes = await sbGet(`routes?code=eq.${enc(from)}&service_date=eq.${enc(date)}&select=id&limit=1`)
  if (!fromRoutes[0]) return { moved: 0, from, to, date, note: `No ${from} route on ${date}.` }
  const propIds = await resolvePropertyIds(a)
  if (!propIds.length) return { moved: 0, from, to, date }
  const stops = await sbGet(`route_stops?route_id=eq.${enc(fromRoutes[0].id)}&property_id=in.(${propIds.join(",")})&select=id`)
  if (!stops.length) return { moved: 0, from, to, date }
  const target = await ensureRoute(to, date)
  const existing = await sbGet(`route_stops?route_id=eq.${enc(target.id)}&select=seq`)
  let seq = nextSeqFrom(existing)
  for (const s of stops) await sbPatch(`route_stops?id=eq.${enc(s.id)}`, { route_id: target.id, seq: ++seq })
  return { moved: stops.length, from, to, date }
}

async function assignDriverTool(a: any) {
  const code = String(a.route_code ?? "").trim().toUpperCase() || await defaultRouteCode()
  const date = a.date ? String(a.date).trim() : today()
  const raw = a.driver == null ? "" : String(a.driver).trim()
  const wantUnassign = a.unassign === true || raw.toLowerCase() === "none" || raw === ""

  let driverId: string | null = null
  let driverName: string | null = null
  if (!wantUnassign) {
    const like = `*${raw}*`
    const or = `or=(full_name.ilike.${enc(like)},email.ilike.${enc(like)})`
    const rows = await sbGet(`profiles?is_driver=eq.true&${or}&select=id,full_name,email&limit=5`)
    if (!rows.length) {
      throw new Error(`No driver matches "${raw}". Flag them as a driver in the Team tab first (or check the spelling).`)
    }
    if (rows.length > 1) {
      return { needs_clarification: true, matches: rows.map((r: any) => ({ id: r.id, name: r.full_name || r.email })) }
    }
    driverId = rows[0].id
    driverName = rows[0].full_name || rows[0].email
  }

  // Find or create the route for this code + date.
  const routes = await sbGet(`routes?code=eq.${enc(code)}&service_date=eq.${enc(date)}&select=id&limit=1`)
  if (routes[0]) {
    await sbPatch(`routes?id=eq.${enc(routes[0].id)}`, { driver_id: driverId, driver: driverName })
  } else {
    await sbPost("routes", { code, name: `Route ${code}`, service_date: date, driver_id: driverId, driver: driverName })
  }

  let madeDefault = false
  if (a.set_default) {
    await fetch(`${REST}/route_defaults?on_conflict=code`, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ code, driver_id: driverId, updated_at: new Date().toISOString() }),
    })
    madeDefault = true
  }

  return { route: code, date, driver: driverName ?? "Unassigned", set_default: madeDefault }
}

async function bulkAddProperties(a: any) {
  const list = Array.isArray(a.properties) ? a.properties : []
  if (!list.length) throw new Error("No properties provided.")
  if (!a.client_id && !a.client_name) throw new Error("A client_name or client_id is required.")
  // Hand off to the shared SQL importer (one batched insert, deterministic).
  const r = await fetch(`${REST}/rpc/bulk_import_properties`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      payload: {
        customer_id: a.client_id ?? null,
        customer_name: a.client_name ?? null,
        default_service: a.default_service ?? null,
        price: a.price ?? null,
        create_schedule: a.create_schedule ?? false,
        pickup_day: a.pickup_day ?? "monday",
        pickup_freq: a.pickup_freq ?? "weekly",
        properties: list,
      },
    }),
  })
  if (!r.ok) throw new Error(`bulk_import: ${r.status} ${await r.text()}`)
  const out = await r.json()
  return {
    client: a.client_name ?? a.client_id,
    customer_id: out?.customer_id,
    inserted: out?.inserted ?? 0,
    note: "Addresses will be geocoded shortly (in the background / via the Import screen).",
  }
}

async function listNeedsReview(a: any) {
  let custIds: string[] | null = null
  if (a.client_name) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${a.client_name}*`)}&select=id&limit=25`)
    custIds = custs.map((c: any) => c.id)
    if (!custIds.length) return { count: 0, properties: [] }
  }
  let path = `properties?needs_review=is.true&select=id,address,name,price,service,pickup_days,pickup_frequency,customer_id&order=created_at.asc&limit=200`
  if (custIds) path += `&customer_id=in.(${custIds.join(",")})`
  const rows = await sbGet(path)
  // Attach client names.
  const ids = [...new Set(rows.map((r: any) => r.customer_id).filter(Boolean))]
  const nameById: Record<string, string> = {}
  if (ids.length) {
    const cs = await sbGet(`customers?id=in.(${ids.join(",")})&select=id,name`)
    for (const c of cs) nameById[c.id] = c.name
  }
  return {
    count: rows.length,
    properties: rows.map((r: any) => ({
      id: r.id,
      client: nameById[r.customer_id] || null,
      address: r.address || r.name,
      price: r.price,
      service: r.service,
      pickup_days: r.pickup_days || [],
      pickup_frequency: r.pickup_frequency,
    })),
  }
}

async function editProperty(a: any) {
  // Resolve the target property.
  let propId = a.property_id as string | undefined
  if (!propId) {
    if (!a.address) throw new Error("Provide an address (or property_id) of the property to edit.")
    const like = enc(`*${a.address}*`)
    let path = `properties?or=(address.ilike.${like},name.ilike.${like})&select=id,address,name,customer_id&limit=10`
    let rows = await sbGet(path)
    if (a.client_name && rows.length > 1) {
      const custs = await sbGet(`customers?name=ilike.${enc(`*${a.client_name}*`)}&select=id&limit=25`)
      const cset = new Set(custs.map((c: any) => c.id))
      rows = rows.filter((r: any) => cset.has(r.customer_id))
    }
    if (!rows.length) throw new Error(`No property matches "${a.address}".`)
    if (rows.length > 1) {
      return { needs_clarification: true, matches: rows.map((r: any) => ({ id: r.id, address: r.address || r.name })) }
    }
    propId = rows[0].id
  }
  // Build the patch.
  const patch: Record<string, unknown> = {}
  if (a.price !== undefined) patch.price = a.price
  if (a.service !== undefined) patch.service = a.service
  if (a.notes !== undefined) patch.notes = a.notes
  if (Array.isArray(a.pickup_days)) patch.pickup_days = a.pickup_days
  if (a.pickup_freq !== undefined) patch.pickup_frequency = a.pickup_freq
  if (a.mark_reviewed === true) patch.needs_review = false
  else if (a.needs_review !== undefined) patch.needs_review = a.needs_review
  if (Object.keys(patch).length === 0) throw new Error("Nothing to change — specify a field to update or mark_reviewed.")
  const [row] = await sbPatch(`properties?id=eq.${enc(propId)}`, patch)
  if (!row) throw new Error("Property not found.")
  return {
    id: row.id,
    address: row.address || row.name,
    updated: Object.keys(patch),
    needs_review: row.needs_review,
  }
}

async function flagProperties(a: any) {
  if (!a.by_customer && !a.by_customer_id && !a.by_tag && !a.address_contains) {
    throw new Error("Tell me which properties to flag — by client, tag, or address.")
  }
  const ids = await resolvePropertyIds(a)
  const want = a.needs_review !== false // default true
  if (!ids.length) return { matched: 0, changed: 0, needs_review: want }
  let changed = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const rows = await sbPatch(`properties?id=in.(${chunk.join(",")})`, { needs_review: want })
    changed += rows.length
  }
  return { matched: ids.length, changed, needs_review: want }
}

async function runTool(name: string, input: any): Promise<unknown> {
  switch (name) {
    case "find_clients": return await findClients(input)
    case "list_needs_review": return await listNeedsReview(input)
    case "edit_property": return await editProperty(input)
    case "flag_properties": return await flagProperties(input)
    case "get_overview": return await getOverview()
    case "create_client": return await createClient(input)
    case "update_client": return await updateClient(input)
    case "create_schedule": return await createSchedule(input)
    case "tag_client": return await tagClient(input)
    case "create_invoice": return await createInvoice(input)
    case "mark_invoice_paid": return await markInvoicePaid(input)
    case "add_stop_to_route": return await addStopToRoute(input)
    case "assign_driver": return await assignDriverTool(input)
    case "list_routes": return await listRoutes()
    case "create_route": return await createRoute(input)
    case "assemble_route": return await assembleRoute(input)
    case "move_stops": return await moveStops(input)
    case "bulk_add_properties": return await bulkAddProperties(input)
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
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, tools, messages }),
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
    // Randy can mutate data via the service role, so require an authenticated
    // staff caller (the frontend sends the signed-in user's token).
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    const ures = token
      ? await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
      : null
    if (!ures || !ures.ok) return json({ text: "Please sign in to use Trashy Randy.", actions: [] }, 401)
    const callerId = (await ures.json())?.id
    const prof = callerId ? await sbGet(`profiles?id=eq.${enc(callerId)}&select=role`) : []
    if (!["admin", "staff"].includes(prof?.[0]?.role)) {
      return json({ text: "Trashy Randy is only available to staff accounts.", actions: [] }, 403)
    }

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
          if (block.name !== "find_clients" && block.name !== "get_overview" && block.name !== "list_routes" && block.name !== "list_needs_review") {
            actions.push({ tool: block.name, result: out })
            await logForTool(block.name, out)
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
