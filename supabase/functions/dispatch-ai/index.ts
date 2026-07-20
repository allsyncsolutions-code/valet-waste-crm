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

const BASE_SYSTEM = `You are Trashy Randy, the dispatch assistant inside Valet Waste, a CRM for a waste-hauling business. You help manage clients, pickup schedules, invoices, tags, and routes. Keep replies tight (1-4 sentences) and always finish the actual task.

CRITICAL — CUSTOMER-FACING TEXT IS ALWAYS CLEAN: anything a customer could ever see — invoice line-item descriptions, invoice notes, SMS message text, and any names/notes you write into records — must be 100% professional and free of profanity or slang, no matter your chat tone. Your personality ONLY colors your chat replies to staff inside this dispatch console.

CRITICAL — YOUR NAME: "Trashy Randy" is an INTERNAL nickname for staff only. In anything a customer could see (texts to clients, invoice messages, notes on records), you are "Randy AI" — the Valet Waste assistant. Never use the name "Trashy Randy" in customer-facing text.

Guidelines:
- When the user refers to a client by name, business, phone or email, call find_clients FIRST to resolve the exact customer_id before acting. If multiple match, ask which one. If none match and the action needs an existing client, say so. find_clients also resolves a SERVICE ADDRESS to its owning client (it falls back to matching properties), so use it to answer "who is the client for <address>?".
- Infer sensible defaults: weekly pickup on Monday, monthly invoicing. Invoices are created as drafts unless told otherwise.
- You can create_client, update_client, create_schedule (pickup), tag_client, create_invoice, mark_invoice_paid, add_stop_to_route, assemble_route, move_stops, assign_driver, list_routes, and create_route. Use get_overview for balances/counts and list_routes to see which routes exist.
- Routes are per DAY and there can be several (e.g. Route A, B). Every route op defaults to TODAY and to the first route unless the user names a date or a route. If more than one route exists and it's ambiguous which they mean, call list_routes and ask.
- assemble_route adds EXISTING properties to a route by selector: by_customer (name), by_tag, or address_contains — e.g. "build Route B today from everything tagged North Side" or "add all of Acme's stops to Route A". add_stop_to_route is for ONE brand-new address (it creates the property). bulk_add_properties imports many NEW addresses for one client.
- move_stops moves matching stops from one route to another on a date (from_route_code → to_route_code), which hands them to the other route's driver. Pick which stops by_customer or address_contains.
- assign_driver assigns (or unassigns) a driver for a route on a date; the driver must be flagged in the Team tab. set_default:true makes them the route's default. create_route adds a new route (code + name).
- When the user gives you MORE THAN ONE property/address for the same client (a pasted list, a vendor sheet, etc.), use bulk_add_properties ONCE with all of them — do not call add_stop_to_route in a loop. Pass every row in the properties array and report how many were added.
- Staff flag uncertain imported properties as "Needs review" (e.g. unclear pricing or pickup frequency). Use list_needs_review to report what's flagged ("what needs review?"). Use edit_property to fix ONE property the owner is reviewing — set price/service/pickup_days/notes — and pass mark_reviewed:true to clear the flag once it's right. Find the property by address (add client_name if the address is ambiguous); if edit_property returns needs_clarification, ask the user which match they mean.
- Use flag_properties to flag or unflag MANY properties at once by client, tag, or address (e.g. "flag everything for Staylah for review" → by_customer:"Staylah"; "clear review on all Palm Coast properties" → address_contains:"Palm Coast", needs_review:false). It defaults to flagging; pass needs_review:false to clear.
- Use find_duplicates when the user asks about duplicate stops/addresses/properties. It returns groups of the same address used under more than one client; summarize the count and call out a few examples (address + the clients involved). To then flag those for cleanup, use flag_properties.
- Use list_skipped_stops to report addresses that were NOT checked in (skipped) on a day — e.g. "what got skipped yesterday?" or "which stops weren't picked up on June 24?". It defaults to today; pass a date or a route_code to narrow it.
- Use add_property_photo to log a dated photo/missed-pickup entry onto an ADDRESS's file (e.g. "log that 123 Main wasn't picked up June 24, bin not out"). You can't take a picture yourself, so unless the user gives you an image_url this logs a dated note the owner attaches the real photo to in Clients › property › Photos. Always set the date to the day it applies to. Resolve the property by address (add client_name if ambiguous); if it returns needs_clarification, ask which match.
- Use text_invoice to text a client their invoice with a Stripe payment link (by invoice number, or client name for their newest unpaid). Pass preview_to with a staff member's name to send them a preview first — the invoice isn't marked sent until you call it for real. You still cannot charge cards directly.
- BUSINESS LINES: the company runs three lines — waste (Waste & Recycling: recurring routed pickups), junk (Junk Removal: ONE-TIME jobs on a calendar, no routes), and lawn (Lawn Care). You see across ALL lines. Junk jobs are created with create_job and live on the Junk calendar. create_job automatically checks how close the job address is to that day's route stops and returns route_proximity — always mention it when scheduling (e.g. "booked it — it's 0.4 mi from stop 8 on Route A, so slot it after that stop" or "heads up, nearest route stop that day is 11 mi away"). If the proximity is far, offer to check other days' routes with list_route_stops to find a better date. When staff ask when a junk job could fit BEFORE booking, look at that day's trash routes (list_route_stops) and the job addresses, and recommend a slot near where a route already passes.
- After making a change, confirm what you did in one short sentence.`

// Selectable personalities for Randy's STAFF chat replies. The customer-facing
// guardrail in BASE_SYSTEM always wins — these only flavor the dispatch console.
const TONES: Record<string, string> = {
  professional:
    "TONE: Professional. Neutral, concise, operational. No jokes, no profanity, no slang. Just the facts and the action.",
  friendly:
    "TONE: Friendly. Warm, casual, and encouraging with a little light humor. Talk like a helpful coworker. No profanity.",
  funny:
    "TONE: Funny (clean). Be genuinely witty — quick one-liners, playful asides, the occasional trash-hauling pun. Keep it PG: NO profanity. Land the joke, then nail the answer/action.",
  spicy:
    "TONE: Spicy. You're a hilarious, foul-mouthed dispatch buddy who loves this messy business. Crack jokes, talk trash (literally), and curse freely for comedic emphasis — f-bombs are fine in staff chat. HARD RULES: (1) never aim profanity AT the user or any person — it's for vibe and emphasis, never an insult; (2) absolutely no slurs or hateful/harassing language; (3) always still complete the task and give correct info. Be funny as hell, then get the job done.",
  hype:
    "TONE: Hype. High-energy hype-man. Big enthusiasm, celebrate the wins, light slang, lots of momentum. No profanity.",
  deadpan:
    "TONE: Deadpan. Dry, sarcastic, understated, mildly world-weary. Minimal words, maximum side-eye. A stray 'damn' or 'hell' is fine; no f-bombs.",
}
const DEFAULT_TONE = "spicy"

function buildSystem(tone?: string | null): string {
  const key = (tone || DEFAULT_TONE).toLowerCase()
  return `${BASE_SYSTEM}\n\n${TONES[key] || TONES[DEFAULT_TONE]}`
}

const tools = [
  {
    name: "find_clients",
    description: "Search customers by name, business, email, phone or address. Returns matches with ids. Also resolves a service-property ADDRESS to its owning client (falls back to matching properties when no customer matches). Use this to resolve who the user means before acting, to answer 'who is the client for <address>?', or to answer questions about a client's contact info.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Name, email, phone or address fragment" } },
      required: ["query"],
    },
  },
  {
    name: "list_properties",
    description: "List all service properties (addresses) belonging to a client, with each property's address, service, monthly price and pickup days. Use this to itemize an invoice with one line per property address, to count how many stops/addresses a client has, or to answer 'what addresses does <client> have?'. Provide customer_id (preferred) or a client name in query.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "The client's id (preferred — get it from find_clients)" },
        query: { type: "string", description: "Client name to resolve if you don't have the id" },
      },
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
    description: "Create an invoice (draft by default) for a customer with line items. Totals are computed automatically. To bill one line PER service address, call list_properties first to get each property's address and price, then pass one line item per property.",
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
        needs_review: { type: "boolean", description: "If true, flag every imported property as 'Needs review' (for messy data the owner should go over)." },
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
  {
    name: "find_duplicates",
    description:
      "Find duplicate service addresses — the same address entered more than once, across ALL clients (matching ignores case, punctuation, St/Street, and a trailing ', USA'). Use when the user asks about duplicate stops/addresses/properties or wants a data-cleanup check. Returns the biggest duplicate groups with the clients each copy is under.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max duplicate groups to return (default 25)." },
      },
    },
  },
  {
    name: "list_skipped_stops",
    description:
      "List service addresses that were NOT checked in (skipped) on a given day — route stops with no driver check-in for that service date. Use when the user asks which addresses were missed / not picked up / not checked in on a date (e.g. 'what got skipped yesterday?'). Returns each skipped stop's address, route, and owning client. Defaults to today.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Service date YYYY-MM-DD. Defaults to today." },
        route_code: { type: "string", description: "Optional — limit to one route code/letter." },
      },
    },
  },
  {
    name: "add_property_photo",
    description:
      "Add a dated photo / missed-pickup entry to an ADDRESS's file (the property's Photos). Use to document an address that was not checked in on a day (e.g. 'log that 123 Main wasn't picked up June 24, bin not out'). Find the property by address (add client_name to disambiguate a shared address). You cannot capture an image yourself, so this logs a dated note entry the owner can attach the actual photo to in the Clients > property > Photos panel — UNLESS the user gives you an image_url, which is stored as the photo. Always set the date to the day it applies to.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address (or part of it) of the property. Required unless property_id is given." },
        property_id: { type: "string", description: "Exact property id, if known. Use instead of address." },
        client_name: { type: "string", description: "Optional — the owning client, to disambiguate a shared address." },
        date: { type: "string", description: "Photo / missed-pickup date YYYY-MM-DD. Defaults to today." },
        note: { type: "string", description: "Short note, e.g. 'bin not out', 'gate locked'." },
        image_url: { type: "string", description: "Optional public image URL to store as the photo, if the user provides one." },
      },
    },
  },
  {
    name: "list_route_stops",
    description:
      "List the stops on a route for a given day, in driving order — address, client, and status (pending / checked in / done) for each. Use when asked things like 'what are the stops on route A today?' or 'give me tomorrow's stop list'. Omit route_code to get every route that day.",
    input_schema: {
      type: "object",
      properties: {
        route_code: { type: "string", description: "Route code/letter (e.g. 'A'). Omit for all routes." },
        date: { type: "string", description: "Service date YYYY-MM-DD. Defaults to today." },
      },
    },
  },
  {
    name: "list_services",
    description:
      "List the services the company offers (plain names, derived from the service recorded on each property). Use when asked 'what services do we offer?'. When answering, give just the list of names — no descriptions or commentary per item.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_job",
    description:
      "Schedule a ONE-TIME job (Junk Removal) on the job calendar for a specific date. Not for recurring pickups — those are schedules. Resolve the client with find_clients first when a client is named; address defaults to the client's if omitted. The result includes route_proximity: how close the job address is to the nearest stop on any route running that date — ALWAYS relay this to the user (e.g. 'that's 0.4 mi from stop 8 on Route A — Randy can hit it after that stop').",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Job date YYYY-MM-DD. Required." },
        client_name: { type: "string", description: "Client the job is for (optional)." },
        address: { type: "string", description: "Job address. Defaults to the client's address." },
        time_window: { type: "string", description: "e.g. '9-11am' (optional)." },
        amount: { type: "number", description: "Price for the job (optional)." },
        driver_name: { type: "string", description: "Driver to assign (optional)." },
        notes: { type: "string", description: "Notes (optional)." },
        business_line: { type: "string", description: "Defaults to 'junk'." },
      },
      required: ["date"],
    },
  },
  {
    name: "list_jobs",
    description:
      "List one-time jobs (Junk Removal calendar) for a date or date range — who, where, price, status, driver. Use for 'what junk jobs are scheduled this week?' or to check the calendar before recommending a slot.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Single date YYYY-MM-DD. Defaults to today." },
        end_date: { type: "string", description: "Optional range end (inclusive)." },
      },
    },
  },
  {
    name: "list_automations",
    description:
      "List the automations on the CRM's Automations tab — things that run on a schedule (like the daily outstanding-balance digest) plus suggested ones awaiting staff approval. Use when asked what's automated or what Randy runs automatically.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "suggest_automation",
    description:
      "Log a new automation idea to the Automations tab as 'suggested' for staff to approve. Use when staff ask for something recurring/automatic that you can't do yet, or when you notice a task you keep repeating that could run on a schedule. Never claim it's active — it starts as a suggestion.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. 'Weekly missed-pickup summary'." },
        description: { type: "string", description: "What it would do, when it runs, and who gets notified." },
        requested_by: { type: "string", description: "Who asked for it, if a staff member did." },
      },
      required: ["name"],
    },
  },
  {
    name: "text_invoice",
    description:
      "Text a client their invoice with a Stripe payment link. Finds the invoice by its number, or by client name (their newest unpaid invoice). Creates the payment link if the invoice doesn't have one yet, sends the invoice SMS template to the client's phone, and marks the invoice sent. Use for 'text the Smith invoice', 'send Bee Clean a payment link', overdue-balance nudges, etc.",
    input_schema: {
      type: "object",
      properties: {
        invoice_number: { type: "string", description: "Invoice number, if known." },
        client_name: { type: "string", description: "Client name — uses their newest unpaid invoice." },
        custom_message: { type: "string", description: "Optional custom SMS text; supports {customerName} {invoiceNumber} {total} {payLink} {companyName} tokens. Omit to use the saved template." },
        preview_to: { type: "string", description: "Staff member's name to send a PREVIEW to instead of the client — they receive exactly what the client would (real pay link included) but the invoice is NOT marked sent. Use when staff want to see it first, then call again without preview_to to send for real." },
      },
    },
  },
  {
    name: "send_sms",
    description:
      "Send a text message (SMS) from the company's RingCentral number to a team member, a client, or a raw phone number. Use for things like telling a driver their route is ready, or sending a client a quick note. Give the recipient as a staff name, client name, or phone number. The text goes out under the company's name to a real phone: the message body must ALWAYS be clean and professional — no cussing or slang in the SMS itself, regardless of your tone setting.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient: a team member's name, a client's name, or a phone number." },
        message: { type: "string", description: "The text message to send. Plain, clean, professional." },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "set_completion_texts",
    description:
      "Turn the 'service complete' customer text ON or OFF (the master switch). When ON, a customer automatically gets a text the moment a tech marks their stop complete (check-out). Multi-location property managers are still auto-skipped, and per-client overrides still apply — this only flips the global switch. Use when staff say things like 'turn on completion texts', 'text customers when we finish the job', or 'stop the service-done texts'. Arrival (on-the-way) texts are separate and always on.",
    input_schema: {
      type: "object",
      properties: {
        on: { type: "boolean", description: "true to turn service-complete texts on, false to turn them off." },
      },
      required: ["on"],
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
    case "add_property_photo": return out.needs_clarification ? undefined : logActivity("property_photo_added", `Logged a ${out.date} photo on ${out.address}`, "property", out.id)
    case "send_sms": return out.ok ? logActivity("sms_sent", `Texted ${out.to}`) : undefined
    case "text_invoice": return out.ok ? logActivity(out.preview ? "invoice_previewed" : "invoice_texted", out.preview ? `Previewed invoice ${out.invoice} to ${out.sent_to}` : `Texted invoice ${out.invoice} to ${out.client}`, "invoice") : undefined
    case "suggest_automation": return out.ok ? logActivity("automation_suggested", `Suggested automation: ${out.name}`) : undefined
    case "create_job": return out.ok ? logActivity("job_created", `Scheduled a job${out.address ? ` at ${out.address}` : ""} for ${out.date}`, "job", out.id) : undefined
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

// Great-circle distance in miles.
const toRad = (d: number) => (d * Math.PI) / 180
function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8
  const h =
    Math.sin(toRad(bLat - aLat) / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(toRad(bLng - aLng) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Best-effort: find the route stop nearest to `address` among routes running on
// `date`. Used by create_job so Randy can say "that's 0.4 mi from stop 8 on
// Route A" and suggest slotting the junk job around the truck's path.
const NEARBY_MILES = 2
async function nearbyRouteStop(address: string, date: string) {
  try {
    const loc = await geocode(address)
    if (!loc) return { note: "Couldn't geocode the job address, so no route-proximity check was done." }
    const routes = await sbGet(`routes?service_date=eq.${enc(date)}&select=id,code,name,driver,driver_id`)
    if (!routes.length) return { note: `No routes run on ${date} — nothing to be near.` }
    const ids = routes.map((r: any) => r.id)
    const stops = await sbGet(`route_stops?route_id=in.(${ids.join(",")})&select=route_id,seq,properties(address,name,lat,lng)&limit=500`)
    let best: any = null
    for (const s of stops) {
      const p = s.properties
      const lat = p?.lat == null ? null : Number(p.lat)
      const lng = p?.lng == null ? null : Number(p.lng)
      if (lat == null || lng == null || (lat === 0 && lng === 0)) continue
      const miles = milesBetween(loc.lat, loc.lng, lat, lng)
      if (!best || miles < best.miles) {
        const r = routes.find((x: any) => x.id === s.route_id)
        best = { miles, route: r?.code, route_name: r?.name, driver: r?.driver || null, driver_id: r?.driver_id || null, stop_seq: s.seq, stop_address: p.address || p.name }
      }
    }
    if (!best) return { note: `Routes exist on ${date} but their stops have no coordinates yet.` }
    return {
      near_route: best.miles <= NEARBY_MILES,
      distance_miles: Math.round(best.miles * 10) / 10,
      route: best.route,
      route_name: best.route_name,
      driver: best.driver || (await driverName(best.driver_id)),
      nearest_stop_seq: best.stop_seq,
      nearest_stop_address: best.stop_address,
    }
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
  if (rows.length) return { matches: rows }
  // Fallback: the query may be a SERVICE-PROPERTY address (clients usually have
  // no address of their own — the addresses live on their properties). Resolve
  // the owning client(s) by matching the property address/name.
  const plike = enc(`*${q}*`)
  const props = await sbGet(`properties?or=(address.ilike.${plike},name.ilike.${plike})&select=address,customer_id,customers(id,name,contact_name,email,phone,status)&limit=10`)
  const seen = new Set<string>()
  const matches: any[] = []
  for (const p of props) {
    const c = p.customers
    if (c && !seen.has(c.id)) { seen.add(c.id); matches.push({ ...c, matched_property: p.address }) }
  }
  return { matches, matched_by_property: matches.length > 0 }
}

// List a client's service properties so Randy can itemize invoices per address,
// count stops, etc. Accepts a customer_id (preferred) or a client name in query.
async function listProperties(a: any) {
  let customerId = a.customer_id ? String(a.customer_id).trim() : ""
  let clientName = ""
  if (!customerId) {
    const q = String(a.query ?? "").trim()
    if (!q) throw new Error("Provide a customer_id or a client name in query.")
    const rows = await sbGet(`customers?name=ilike.${enc(`*${q}*`)}&select=id,name&limit=6`)
    if (!rows.length) return { count: 0, properties: [], note: `No client matches "${q}".` }
    if (rows.length > 1) {
      return { needs_clarification: true, candidates: rows.map((r: any) => ({ id: r.id, name: r.name })) }
    }
    customerId = rows[0].id
    clientName = rows[0].name
  }
  const props = await sbGet(
    `properties?customer_id=eq.${enc(customerId)}&select=id,code,name,address,service,price,pickup_days,needs_review&order=address.asc`,
  )
  if (!clientName) {
    const c = await sbGet(`customers?id=eq.${enc(customerId)}&select=name&limit=1`)
    clientName = c[0]?.name ?? ""
  }
  return {
    customer_id: customerId,
    client: clientName,
    count: props.length,
    properties: props.map((p: any) => ({
      id: p.id,
      address: p.address,
      name: p.name,
      service: p.service,
      price: p.price,
      pickup_days: p.pickup_days,
      needs_review: p.needs_review,
    })),
  }
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
        needs_review: a.needs_review ?? false,
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
    duplicates: out?.duplicates ?? 0,
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

async function findDuplicates(a: any) {
  const lim = Number(a?.limit) > 0 ? Math.floor(Number(a.limit)) : 25
  const r = await fetch(`${REST}/rpc/duplicate_summary`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ lim }),
  })
  if (!r.ok) throw new Error(`find_duplicates: ${r.status} ${await r.text()}`)
  const groups = await r.json()
  return { count: Array.isArray(groups) ? groups.length : 0, duplicates: groups }
}

// Resolve exactly one property from address/property_id (+ optional client_name).
// Returns { id, address } or { needs_clarification, matches } when ambiguous.
async function resolveOneProperty(a: any): Promise<any> {
  if (a.property_id) {
    const rows = await sbGet(`properties?id=eq.${enc(a.property_id)}&select=id,address,name&limit=1`)
    if (!rows[0]) throw new Error("Property not found.")
    return { id: rows[0].id, address: rows[0].address || rows[0].name }
  }
  if (!a.address) throw new Error("Provide an address (or property_id) of the property.")
  const like = enc(`*${a.address}*`)
  let rows = await sbGet(`properties?or=(address.ilike.${like},name.ilike.${like})&select=id,address,name,customer_id&limit=10`)
  if (a.client_name && rows.length > 1) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${a.client_name}*`)}&select=id&limit=25`)
    const cset = new Set(custs.map((c: any) => c.id))
    rows = rows.filter((r: any) => cset.has(r.customer_id))
  }
  if (!rows.length) throw new Error(`No property matches "${a.address}".`)
  if (rows.length > 1) {
    return { needs_clarification: true, matches: rows.map((r: any) => ({ id: r.id, address: r.address || r.name })) }
  }
  return { id: rows[0].id, address: rows[0].address || rows[0].name }
}

async function addPropertyPhoto(a: any) {
  const resolved = await resolveOneProperty(a)
  if (resolved.needs_clarification) return resolved
  const date = a.date ? String(a.date).trim() : today()
  const row: Record<string, unknown> = {
    property_id: resolved.id,
    taken_on: date,
    note: a.note ?? null,
    image_url: a.image_url ?? null,
    source: "randy",
  }
  const [created] = await sbPost("property_photos", row)
  return {
    id: created.id,
    address: resolved.address,
    date,
    note: a.note ?? null,
    has_image: !!a.image_url,
    message: a.image_url
      ? `Saved a photo to ${resolved.address}'s file dated ${date}.`
      : `Logged a ${date} photo entry on ${resolved.address}'s file — attach the actual photo in Clients › the property › Photos.`,
  }
}

async function listSkippedStops(a: any) {
  const date = a.date ? String(a.date).trim() : today()
  let routeFilter = ""
  if (a.route_code) {
    const code = String(a.route_code).trim().toUpperCase()
    const rs = await sbGet(`routes?service_date=eq.${enc(date)}&code=eq.${enc(code)}&select=id`)
    const ids = rs.map((r: any) => r.id)
    if (!ids.length) return { date, count: 0, skipped: [], note: `No route ${code} on ${date}.` }
    routeFilter = `&route_id=in.(${ids.join(",")})`
  }
  // Stops on that service date with no check-in = not checked in / skipped.
  const stops = await sbGet(
    `route_stops?check_in=is.null${routeFilter}&select=id,status,routes!inner(code,service_date),properties(name,address,customer_id)&routes.service_date=eq.${enc(date)}&order=seq.asc&limit=300`,
  )
  const custIds = [...new Set(stops.map((s: any) => s.properties?.customer_id).filter(Boolean))]
  const nameById: Record<string, string> = {}
  if (custIds.length) {
    const cs = await sbGet(`customers?id=in.(${custIds.join(",")})&select=id,name`)
    for (const c of cs) nameById[c.id] = c.name
  }
  return {
    date,
    count: stops.length,
    skipped: stops.map((s: any) => ({
      address: s.properties?.address || s.properties?.name || "(unknown)",
      route: s.routes?.code,
      client: s.properties?.customer_id ? (nameById[s.properties.customer_id] || null) : null,
      status: s.status,
    })),
  }
}

// "Trashy Randy" is staff-only; customers only ever see "Randy AI".
const externalName = (s: string) => s.replace(/trashy\s+randy/gi, "Randy AI")

async function listRouteStops(a: any) {
  const date = a.date ? String(a.date).trim() : today()
  let routes = await sbGet(`routes?service_date=eq.${enc(date)}&select=id,code,name,driver,driver_id&order=code.asc`)
  if (a.route_code) {
    const code = String(a.route_code).trim().toUpperCase()
    routes = routes.filter((r: any) => (r.code || "").toUpperCase() === code)
    if (!routes.length) return { date, routes: [], note: `No route ${code} on ${date}.` }
  }
  if (!routes.length) return { date, routes: [], note: `No routes on ${date}.` }
  const ids = routes.map((r: any) => r.id)
  const stops = await sbGet(
    `route_stops?route_id=in.(${ids.join(",")})&select=route_id,seq,status,check_in,check_out,properties(name,address,customer_id)&order=seq.asc&limit=300`,
  )
  const custIds = [...new Set(stops.map((s: any) => s.properties?.customer_id).filter(Boolean))]
  const nameById: Record<string, string> = {}
  if (custIds.length) {
    for (const c of await sbGet(`customers?id=in.(${custIds.join(",")})&select=id,name`)) nameById[c.id] = c.name
  }
  const out = []
  for (const r of routes) {
    out.push({
      route: r.code,
      name: r.name,
      driver: r.driver || (await driverName(r.driver_id)),
      stops: stops.filter((s: any) => s.route_id === r.id).map((s: any) => ({
        seq: s.seq,
        address: s.properties?.address || s.properties?.name || "(unknown)",
        client: s.properties?.customer_id ? (nameById[s.properties.customer_id] || null) : null,
        status: s.check_out ? "done" : s.check_in ? "checked in" : (s.status || "pending"),
      })),
    })
  }
  return { date, routes: out }
}

async function listServices() {
  const rows = await sbGet(`properties?select=service&service=not.is.null&limit=2000`)
  const services = [...new Set(rows.map((r: any) => String(r.service || "").trim()).filter(Boolean))].sort()
  return services.length ? { services } : { services, note: "No services recorded on properties yet." }
}

async function createJobTool(a: any) {
  const date = String(a.date || "").trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Give me the job date as YYYY-MM-DD." }

  let customerId: string | null = null
  let address = a.address ? String(a.address).trim() : ""
  let clientName: string | null = null
  if (a.client_name) {
    const cs = await sbGet(`customers?name=ilike.*${enc(String(a.client_name).trim())}*&select=id,name,address&limit=5`)
    if (!cs.length) return { error: `No client matched "${a.client_name}".` }
    if (cs.length > 1) return { needs_clarification: true, matches: cs.map((c: any) => c.name), note: "Multiple clients match — which one?" }
    customerId = cs[0].id
    clientName = cs[0].name
    if (!address) address = cs[0].address || ""
  }

  let driverId: string | null = null
  let driverName: string | null = null
  if (a.driver_name) {
    const ds = await sbGet(`profiles?is_driver=eq.true&full_name=ilike.*${enc(String(a.driver_name).trim())}*&select=id,full_name`)
    if (!ds.length) return { error: `No driver matched "${a.driver_name}".` }
    if (ds.length > 1) return { needs_clarification: true, matches: ds.map((d: any) => d.full_name), note: "Multiple drivers match — which one?" }
    driverId = ds[0].id
    driverName = ds[0].full_name
  }

  const rows = await sbPost("jobs", {
    business_line: a.business_line === "lawn" || a.business_line === "waste" ? a.business_line : "junk",
    customer_id: customerId,
    address: address || null,
    scheduled_date: date,
    time_window: a.time_window ? String(a.time_window) : null,
    amount: a.amount != null ? round2(Number(a.amount)) : null,
    driver_id: driverId,
    notes: a.notes ? String(a.notes) : null,
  })

  // Route-proximity check: is this job near a stop on a route running that day?
  const route_proximity = address ? await nearbyRouteStop(address, date) : { note: "No address on the job — no route-proximity check." }

  return { ok: true, id: rows?.[0]?.id, date, client: clientName, address, driver: driverName, amount: a.amount ?? null, route_proximity }
}

async function listJobs(a: any) {
  const date = a.date ? String(a.date).trim() : today()
  const end = a.end_date ? String(a.end_date).trim() : date
  const rows = await sbGet(
    `jobs?scheduled_date=gte.${enc(date)}&scheduled_date=lte.${enc(end)}&select=scheduled_date,address,time_window,status,amount,notes,customer_id,driver_id&order=scheduled_date.asc&limit=100`,
  )
  const custIds = [...new Set(rows.map((j: any) => j.customer_id).filter(Boolean))]
  const names: Record<string, string> = {}
  if (custIds.length) for (const c of await sbGet(`customers?id=in.(${custIds.join(",")})&select=id,name`)) names[c.id] = c.name
  return {
    from: date,
    to: end,
    count: rows.length,
    jobs: await Promise.all(rows.map(async (j: any) => ({
      date: j.scheduled_date,
      client: j.customer_id ? (names[j.customer_id] || null) : null,
      address: j.address,
      window: j.time_window,
      status: j.status,
      amount: j.amount,
      driver: await driverName(j.driver_id),
      notes: j.notes,
    }))),
  }
}

async function listAutomations() {
  const rows = await sbGet(`automations?select=kind,name,description,status,last_run_at&order=created_at.asc`)
  return { automations: rows }
}

async function suggestAutomation(a: any) {
  const name = String(a.name || "").trim()
  if (!name) return { error: "Give the automation a short name." }
  const kind = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  try {
    const rows = await sbPost("automations", {
      kind,
      name,
      description: a.description ? String(a.description) : null,
      status: "suggested",
      requested_by: a.requested_by ? String(a.requested_by) : "Trashy Randy",
    })
    return { ok: true, id: rows?.[0]?.id, name, note: "Logged as suggested — staff can approve it on the Automations tab." }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("duplicate") || msg.includes("23505")) return { error: "An automation like that is already on the Automations tab." }
    throw e
  }
}

async function setCompletionTexts(a: any) {
  const on = a.on === true || a.on === "true" || a.on === 1
  await sbPatch(`app_settings?id=eq.1`, { notify_on_complete: on, updated_at: new Date().toISOString() })
  await logActivity("settings", `${on ? "Turned ON" : "Turned OFF"} service-complete texts`, "app_settings", "1")
  return {
    ok: true,
    notify_on_complete: on,
    note: on
      ? "Service-complete texts are ON — customers get a text when their stop is marked complete. Multi-location managers are still auto-skipped."
      : "Service-complete texts are OFF.",
  }
}

async function textInvoiceTool(a: any) {
  let inv: any = null
  if (a.invoice_number) {
    const rows = await sbGet(`invoices?number=ilike.*${enc(String(a.invoice_number).trim())}*&select=*&order=created_at.desc&limit=3`)
    if (rows.length > 1) return { needs_clarification: true, matches: rows.map((r: any) => r.number), note: "Multiple invoices match — which number?" }
    inv = rows[0]
  } else if (a.client_name) {
    const cs = await sbGet(`customers?name=ilike.*${enc(String(a.client_name).trim())}*&select=id,name&limit=5`)
    if (!cs.length) return { error: `No client matched "${a.client_name}".` }
    if (cs.length > 1) return { needs_clarification: true, matches: cs.map((c: any) => c.name), note: "Multiple clients match — which one?" }
    const rows = await sbGet(`invoices?customer_id=eq.${cs[0].id}&status=neq.paid&select=*&order=created_at.desc&limit=3`)
    if (!rows.length) return { error: `${cs[0].name} has no unpaid invoices.` }
    if (rows.length > 1) return { needs_clarification: true, matches: rows.map((r: any) => `${r.number} ($${r.total}, ${r.status})`), note: "They have multiple unpaid invoices — which one?" }
    inv = rows[0]
  } else {
    return { error: "Give me an invoice number or a client name." }
  }
  if (!inv) return { error: "No matching invoice found." }

  const cust = (await sbGet(`customers?id=eq.${inv.customer_id}&select=id,name,phone`))[0]
  if (!cust?.phone) return { error: `${cust?.name || "That client"} has no phone number on file.` }
  if (!inv.total || Number(inv.total) < 0.5) return { error: "Invoice total must be at least $0.50 for a payment link." }

  // Reuse the stored Stripe link or mint one via the stripe function.
  let payUrl = inv.stripe_payment_url
  if (!payUrl) {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/stripe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "payment_link",
        amount: inv.total,
        description: `${inv.number}${cust.name ? " — " + cust.name : ""}`,
        customerName: cust.name,
        origin: "https://valet-waste-crm.vercel.app",
      }),
    })
    const d = await r.json().catch(() => ({}))
    if (!d?.url) return { error: `Couldn't create a payment link: ${d?.error || "Stripe error"}` }
    payUrl = d.url
  }

  const s = (await sbGet(`app_settings?id=eq.1&select=company_name,sms_invoice_template`))[0] || {}
  const fmt = (v: number) => `$${Number(v).toFixed(2)}`
  const tpl = (a.custom_message && String(a.custom_message).trim()) ||
    s.sms_invoice_template ||
    "Hi {customerName}, invoice {invoiceNumber} for {total} is ready. Pay here: {payLink} — {companyName}"
  const body = externalName(tpl)
    .replaceAll("{customerName}", cust.name || "there")
    .replaceAll("{invoiceNumber}", inv.number || "")
    .replaceAll("{total}", fmt(inv.total))
    .replaceAll("{payLink}", payUrl)
    .replaceAll("{companyName}", s.company_name || "Valet Waste FL")

  // Preview mode: text a STAFF member what the client would get; invoice untouched.
  if (a.preview_to) {
    const staff = await sbGet(`profiles?select=full_name,phone&full_name=ilike.*${enc(String(a.preview_to).trim())}*&phone=not.is.null`)
    if (!staff.length) return { error: `No team member with a phone matched "${a.preview_to}".` }
    if (staff.length > 1) return { needs_clarification: true, matches: staff.map((s: any) => s.full_name), note: "Multiple team members match — which one?" }
    const pr = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to: staff[0].phone, body: `[PREVIEW — would go to ${cust.name}]\n${body}`, purpose: "invoice_preview", sentBy: "Trashy Randy" }),
    })
    const pd = await pr.json().catch(() => ({}))
    if (!pd?.ok) return { error: `SMS failed: ${pd?.error || pr.status}` }
    // Persist the minted link so the real send reuses it, but don't mark sent.
    if (!inv.stripe_payment_url) await sbPatch(`invoices?id=eq.${inv.id}`, { stripe_payment_url: payUrl })
    return { ok: true, preview: true, sent_to: staff[0].full_name, invoice: inv.number, client: cust.name, note: "Preview only — the invoice was NOT marked sent. Call again without preview_to to text the client." }
  }

  const sr = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", to: cust.phone, body, customerId: cust.id, purpose: "invoice", sentBy: "Trashy Randy" }),
  })
  const sd = await sr.json().catch(() => ({}))
  if (!sd?.ok) return { error: `SMS failed: ${sd?.error || sr.status}` }

  await sbPatch(`invoices?id=eq.${inv.id}`, {
    stripe_payment_url: payUrl,
    status: inv.status === "paid" ? inv.status : "sent",
    sent_at: inv.sent_at || new Date().toISOString(),
  })
  return { ok: true, invoice: inv.number, client: cust.name, total: inv.total, pay_link: payUrl }
}

async function sendSmsTool(a: any) {
  const to = String(a.to || "").trim()
  const message = String(a.message || "").trim()
  if (!to || !message) throw new Error("Both a recipient and a message are required.")

  let phone: string | null = null
  let recipient = to
  let customerId: string | null = null
  let isStaff = false

  if (to.replace(/\D/g, "").length >= 10) {
    phone = to
  } else {
    // Team member first…
    const staff = await sbGet(`profiles?select=id,full_name,phone&full_name=ilike.*${enc(to)}*`)
    if (staff.length > 1) {
      return { needs_clarification: true, matches: staff.map((s: any) => s.full_name), note: "Multiple team members match — which one?" }
    }
    if (staff.length === 1) {
      if (!staff[0].phone) return { error: `${staff[0].full_name} has no phone number on file — add one first.` }
      phone = staff[0].phone
      recipient = staff[0].full_name
      isStaff = true
    } else {
      // …then clients.
      const clients = await sbGet(`customers?select=id,name,phone&name=ilike.*${enc(to)}*`)
      if (clients.length > 1) {
        return { needs_clarification: true, matches: clients.map((c: any) => c.name), note: "Multiple clients match — which one?" }
      }
      if (!clients.length) return { error: `No team member or client matched "${to}". Give me a phone number instead.` }
      if (!clients[0].phone) return { error: `${clients[0].name} has no phone number on file.` }
      phone = clients[0].phone
      recipient = clients[0].name
      customerId = clients[0].id
    }
  }

  // Staff keep the inside joke; clients and unknown numbers get "Randy AI".
  const finalBody = isStaff ? message : externalName(message)
  const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", to: phone, body: finalBody, customerId, purpose: "manual", sentBy: "Trashy Randy" }),
  })
  const d = await r.json().catch(() => ({}))
  if (!d?.ok) throw new Error(`SMS failed: ${d?.error || `sms function returned ${r.status}`}`)
  return { ok: true, to: recipient, phone, provider: d.provider || null }
}

async function runTool(name: string, input: any): Promise<unknown> {
  switch (name) {
    case "find_clients": return await findClients(input)
    case "list_properties": return await listProperties(input)
    case "list_needs_review": return await listNeedsReview(input)
    case "edit_property": return await editProperty(input)
    case "flag_properties": return await flagProperties(input)
    case "find_duplicates": return await findDuplicates(input)
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
    case "add_property_photo": return await addPropertyPhoto(input)
    case "list_skipped_stops": return await listSkippedStops(input)
    case "list_route_stops": return await listRouteStops(input)
    case "list_services": return await listServices()
    case "list_automations": return await listAutomations()
    case "suggest_automation": return await suggestAutomation(input)
    case "create_job": return await createJobTool(input)
    case "list_jobs": return await listJobs(input)
    case "text_invoice": return await textInvoiceTool(input)
    case "send_sms": return await sendSmsTool(input)
    case "set_completion_texts": return await setCompletionTexts(input)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

async function callAnthropic(messages: unknown[], apiKey: string, system: string) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools, messages }),
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
    // staff caller (the frontend sends the signed-in user's token). Backend
    // services (e.g. the sms-webhook relaying staff texts) authenticate by
    // presenting the service role key itself — it never reaches the browser.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    const isSystemCaller = !!token && token === SERVICE_KEY
    if (!isSystemCaller) {
      const ures = token
        ? await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
        : null
      if (!ures || !ures.ok) return json({ text: "Please sign in to use Trashy Randy.", actions: [] }, 401)
      const callerId = (await ures.json())?.id
      const prof = callerId ? await sbGet(`profiles?id=eq.${enc(callerId)}&select=role`) : []
      if (!["admin", "staff"].includes(prof?.[0]?.role)) {
        return json({ text: "Trashy Randy is only available to staff accounts.", actions: [] }, 403)
      }
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
    if (!apiKey) {
      return json({
        text: "I'm not connected yet — the ANTHROPIC_API_KEY secret hasn't been set in Supabase. Once it's added I can start helping.",
        actions: [],
      })
    }

    const { messages: incoming, sms } = await req.json()
    const messages: any[] = (incoming || [])
      .filter((m: any) => m && m.text)
      .map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }))

    // Personality is configured in Settings (app_settings.randy_tone).
    let tone: string | null = null
    try { tone = (await sbGet(`app_settings?id=eq.1&select=randy_tone`))?.[0]?.randy_tone ?? null } catch (_) { /* fall back to default */ }
    let system = buildSystem(tone)
    if (isSystemCaller && sms?.staff_name) {
      system += `\n\nSMS MODE: You are replying by TEXT MESSAGE to ${sms.staff_name}, a staff member texting the company's business number from their phone. Rules: reply in plain conversational text only (no markdown, no bullet lists, no headers); keep it under 450 characters; keep the language clean and professional regardless of your tone setting — this is a real SMS from the business number. Your reply text is automatically delivered back to them as a text, so do NOT use the send_sms tool to answer them; only use send_sms if they ask you to text someone ELSE.`
    }

    const actions: Array<{ tool: string; result: unknown }> = []
    let finalText = ""

    for (let i = 0; i < 8; i++) {
      const res = await callAnthropic(messages, apiKey, system)
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
          if (block.name !== "find_clients" && block.name !== "get_overview" && block.name !== "list_routes" && block.name !== "list_needs_review" && block.name !== "find_duplicates" && block.name !== "list_skipped_stops" && block.name !== "list_route_stops" && block.name !== "list_services" && block.name !== "list_automations" && block.name !== "list_jobs") {
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
