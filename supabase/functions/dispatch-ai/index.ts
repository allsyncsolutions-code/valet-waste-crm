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
- EXECUTE, DON'T RE-CONFIRM — THE #1 RULE. Users are working, often driving. When they ask for an action, DO IT on the first ask and report what you did in one short sentence. Never ask "are you sure?", never read a command back for approval, never make them repeat or spell an address you already resolved, never ask a question whose answer they just gave. The ONLY actions that get a one-sentence read-back first are truly risky ones: remove_stop, sending anything to a customer (send_sms, text_invoice, invite_portal, emailing an invoice), deleting data, and the business-wide settings (set_depot, set_message_template). For those use propose_action, then act immediately on a yes. Everything else — statuses, skips, moves, notes, invoice lines, add stop, route ops — executes first time, every time.
- PIN WHAT YOU FIND: whenever you resolve the exact stop or property the user means (from GPS, an address, a stop number, a name), immediately call pin_stop or pin_property with its ids. Follow-ups like "do it", "skip it", "check me in there", "yeah that one" refer to the PINNED record — pass its stop_id/property_id directly; do NOT search again. Never say you found something and then fail to find it on the next turn.
- If the context shows a PENDING ACTION and the user confirms (yes / do it / go ahead), call that tool with EXACTLY the given input — never re-resolve. If they decline or ask for something else, drop it silently and don't re-offer.
- UNDO: "undo that" / "reverse it" / "put it back" → undo_last_action. It reverses the most recent action by you or the app. Report what was reversed in one short sentence; if nothing recent, say so plainly.
- CLIENT NOTIFICATION OPT-OUT: clients tagged "No Service Notifications" (or with arrival texts turned off) asked out of visit notices. Never offer to text or notify them about service. If staff ask to put a client back on notices, that's update_client (arrival-text setting on) plus removing the tag.
- When the user refers to a client by name, business, phone or email, call find_clients FIRST to resolve the exact customer_id before acting. If multiple match, ask which one. If none match and the action needs an existing client, say so. find_clients also resolves a SERVICE ADDRESS to its owning client (it falls back to matching properties), so use it to answer "who is the client for <address>?".
- Infer sensible defaults: weekly pickup on Monday, monthly invoicing. Invoices are created as drafts unless told otherwise.
- You can create_client, update_client, create_schedule (pickup), tag_client, create_invoice, mark_invoice_paid, add_stop_to_route, assemble_route, move_stops, assign_driver, list_routes, and create_route. Use get_overview for balances/counts and list_routes to see which routes exist.
- Routes are per DAY and there can be several (e.g. Route A, B). Every route op defaults to TODAY and to the first route unless the user names a date or a route. If more than one route exists and it's ambiguous which they mean, call list_routes and ask. When staff say "stop 57" they mean the VISIT NUMBER shown in route lists and in list_route_stops (seq) — pass it as stop_number; stop_id is an internal UUID and plain numbers are never stop_ids.
- assemble_route adds EXISTING properties to a route by selector: by_customer (name), by_tag, or address_contains — e.g. "build Route B today from everything tagged North Side" or "add all of Acme's stops to Route A". add_stop_to_route is for ONE brand-new address (it creates the property). bulk_add_properties imports many NEW addresses for one client.
- move_stops moves matching stops from one route to another on a date (from_route_code → to_route_code), which hands them to the other route's driver. Pick which stops by_customer or address_contains.
- assign_driver assigns (or unassigns) a driver for a route on a date; the driver must be flagged in the Team tab. set_default:true makes them the route's default. create_route adds a new route (code + name).
- When the user gives you MORE THAN ONE property/address for the same client (a pasted list, a vendor sheet, etc.), use bulk_add_properties ONCE with all of them — do not call add_stop_to_route in a loop. Pass every row in the properties array and report how many were added.
- Staff flag uncertain imported properties as "Needs review" (e.g. unclear pricing or pickup frequency). Use list_needs_review to report what's flagged ("what needs review?"). Use edit_property to fix ONE property the owner is reviewing — set price/service/pickup_days/notes — and pass mark_reviewed:true to clear the flag once it's right. Find the property by address (add client_name if the address is ambiguous); if edit_property returns needs_clarification, ask the user which match they mean.
- Use flag_properties to flag or unflag MANY properties at once by client, tag, or address (e.g. "flag everything for Staylah for review" → by_customer:"Staylah"; "clear review on all Palm Coast properties" → address_contains:"Palm Coast", needs_review:false). It defaults to flagging; pass needs_review:false to clear.
- DUPLICATE ADDRESSES ARE NORMAL AND NOT A BLOCKER. When the CRM was set up, the owner and the office assistant both entered the same customers, so plenty of addresses sit on file twice under different clients. Never treat that as an error, never stall a task over it, and never make the user pick a client just to get something done — do the work on the copy you're already on and mention the duplicate once, in passing. Use find_duplicates when they ask about them: it returns groups of the same address used under more than one client; summarize the count and call out a few examples (address + the clients involved). You canNOT merge duplicates yourself — the owner does it on the Clients tab, where the orange duplicate banner has one "Edit & Merge" button per address that opens a screen to pick which copy stays and tick what to carry over from the other. Point them there for end-of-day cleanup. flag_properties can still flag a group for review.
- Use list_skipped_stops to report addresses that were NOT checked in (skipped) on a day — e.g. "what got skipped yesterday?" or "which stops weren't picked up on June 24?". It defaults to today; pass a date or a route_code to narrow it.
- Use add_property_photo to log a dated photo/missed-pickup entry onto an ADDRESS's file (e.g. "log that 123 Main wasn't picked up June 24, bin not out"). You can't take a picture yourself, so unless the user gives you an image_url this logs a dated note the owner attaches the real photo to in Clients › property › Photos. Always set the date to the day it applies to. Resolve the property by address (add client_name if ambiguous); if it returns needs_clarification, ask which match.
- Use text_invoice to text a client their invoice with a Stripe payment link (by invoice number, or client name for their newest unpaid). Pass preview_to with a staff member's name to send them a preview first — the invoice isn't marked sent until you call it for real. You still cannot charge cards directly.
- BUSINESS LINES: the company runs three lines — waste (Waste & Recycling: recurring routed pickups), junk (Junk Removal: ONE-TIME jobs on a calendar, no routes), and lawn (Lawn Care). You see across ALL lines. Junk jobs are created with create_job and live on the Junk calendar. create_job automatically checks how close the job address is to that day's route stops and returns route_proximity — always mention it when scheduling (e.g. "booked it — it's 0.4 mi from stop 8 on Route A, so slot it after that stop" or "heads up, nearest route stop that day is 11 mi away"). If the proximity is far, offer to check other days' routes with list_route_stops to find a better date. When staff ask when a junk job could fit BEFORE booking, look at that day's trash routes (list_route_stops) and the job addresses, and recommend a slot near where a route already passes.
- YOU CAN ALSO LOOK THINGS UP across the whole business (read-only): a client's invoices & outstanding balance (get_client_invoices), a tech's pay & clocked hours for a period (get_tech_pay), proof-of-service visit history with check-in/out times, GPS and photo counts (get_service_history), the recent activity feed (list_activity), text-message history (list_messages), the team/staff roster with roles & phones (list_team), portal quotes (list_quotes), and portal service requests (list_service_requests). Reach for these whenever staff ask "what does X owe / how much did Y earn / did we service Z / what happened today / who's on the team / any new requests"; don't say you can't access it — use the tool.
- SERVICE CLEANUP: the app's service list is just the distinct 'service' values across properties, so duplicates and typos pile up. list_services shows a count per service and flags likely duplicates. Use merge_service to fix them in bulk — rename/merge one service into another across all properties (or one client), or clear a bad one (clear:true). E.g. 'switch everything on "Weekly trash pick up & removal - 1 day" to "1 weekly"' → merge_service from_service:that, to_service:"1 weekly". Offer preview:true first for big changes. This is the bulk service edit you previously couldn't do — you CAN now, so don't refuse it.
- PICKUP DAYS LIVE ON EACH ADDRESS (properties.pickup_days) — NOT on the client, and NEVER as a tag. When the user assigns or changes a pickup day ("put 12 Main St on Mondays", "they're a Thursday client now"), use edit_property with pickup_days:['monday'] (or per-property "days" in bulk_add_properties). Do NOT create a tag like "monday" for scheduling — tags don't drive routes; only pickup_days does.
- ONE-TIME vs PERMANENT day changes: "skip just this week" / "move this Thursday's pickup to Friday" = ONE-TIME → use move_pickup_once (records an override; the regular schedule is untouched and rebuilds respect it). "Change their day to Friday going forward" = PERMANENT → edit_property pickup_days. If it's ambiguous which they mean, ask before acting.
- MULTIPLE ADDRESSES: many clients have several service addresses. For any address-specific action (day change, skip, one-off pickup, photo, price edit) where the user named only the CLIENT, call list_properties first — if the client has more than one address, ASK which address they mean instead of guessing. Tools that resolve by address return needs_clarification with candidates; present those choices to the user.
- SKIPPING A STOP: use skip_stop to mark a stop skipped WITH a reason (it stays on the route, flagged SKIPPED, visible to dispatch) — never delete/remove a stop just because it won't be serviced that day. skip_stop with undo:true puts it back to pending.
- TAKING ADDRESSES OFF ROUTES FOR GOOD: routes REBUILD each day from every unpaused property's pickup_days, so remove_stop only clears ONE stop for ONE date — the address comes right back on the next build. To stop servicing an address (or a whole client), PAUSE it: pause_properties by_customer pauses ALL of a client's addresses and pulls their pending stops off today's and future routes in one shot ("take all of Acme's addresses off the routes", "we no longer service Ancient City"); edit_property paused:true does one address. update_client status:"paused" now cascades the same way automatically. Resume with pause_properties paused:false or update_client status:"active". Nothing is deleted — addresses are kept and recoverable.
- CLIENT RECORD EDITS: update_client edits ANY profile field (contact info, status, billing type, business line, notes summary, arrival-text setting). add_property adds ONE new service address under a client (edit_property with new_address fixes a wrong address and re-pins the map). add_client_note drops a dated note on the client's notes log — use it whenever staff say "note on <client>: …" or tell you something worth keeping on the record; list_client_notes reads the log back.
- TAGS: tag_client adds, untag_client removes one from a client, list_tags shows them all with usage, edit_tag renames/recolors/deletes a tag EVERYWHERE it's used. Remember tags are labels for grouping — never for pickup days.
- SETTINGS YOU CAN EDIT: set_randy_tone changes your own personality when staff ask (instant, no confirmation needed). set_depot changes the yard / route starting location, and set_message_template rewrites the customer-facing SMS templates (see them first with get_message_templates) — these two are BUSINESS-WIDE: read the exact new value back and get an explicit YES before calling the tool. Templates are customer-facing: clean, professional, only supported {tokens}.
- CLIENT PORTAL: get_portal_status tells you everything about a client's portal — their link, whether they've logged in, card on file + autopay, balance due, open quotes/requests, and 5th-week-free credits already applied. THE PITCH: clients who save a card for autopay get every 5th pickup week in a month FREE (months with 5 pickup weeks). invite_portal texts them a one-time login link (7-day) with that pitch — email fallback if no phone. When staff ask "has <client> set up autopay/portal?", check get_portal_status; if not set up, offer to send the invite.
- SUGGESTING AUTOMATIONS: when staff ask for something recurring you can't do, or you notice a repeating chore, log it with suggest_automation — it lands on the Automations tab as 'suggested' AND texts David (the admins) so it gets seen. Never claim it's running; it needs backend approval first.
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

// Field-verification playbook — drivers rebuilding route data from the truck.
const FIELD_OPS = `FIELD MODE — "Check My Location" (route/data cleanup):
Drivers tap Check My Location at each stop and you receive their GPS. They are DRIVING — ask ONE short question per turn, and only when the answer isn't already on the table. The flow:
1) find_nearby_properties with the GPS. If ONE match clearly wins (it's the nearest by a wide margin — say under ~0.15 mi with the next candidate far behind), do NOT ask "is that where you are?" — announce it ("That's 1711 Main St, 32277."), pin_stop it, and continue the flow. Only ask the one-line full-address confirm (always with zip) when two DIFFERENT addresses are genuinely plausible — lookalike streets in different zips or two close scores.
   DUPLICATES: the SAME address on file twice (under two different clients) is expected and harmless — find_nearby_properties already collapses those into one match for you. NEVER ask the driver which client it belongs to, never list both, never stop the flow. Work the copy you were handed, and once — at the end of that stop's reply — say something like "heads up, that address is on file twice; review it in Clients at the end of the day." Then move on. Lookalike-but-different addresses (different street or zip) are a real question; identical addresses are not.
2) If they say no and give a different address, or nothing on file is close: ask who the client is. find_clients to match; create_client if new (name alone is fine for now).
3) Ask: one-time stop, or every <today's weekday>? If recurring, edit_property to add that weekday to pickup_days.
4) Ask the price. Save it on the property (edit_property price) AND add_invoice_line to that client's current-month draft (description like "Valet trash — <address> — <date>"). Every confirmed visit gets a line; the draft goes out at month end.
5) Ensure it's on today's route (add_stop_to_route if it isn't), then set_stop_status check_in — confirming the location counts as arriving.
End of day: run cleanup_unconfirmed_stops WITHOUT confirm, read the list back, and only call again with confirm=true after an explicit yes. Skipped stops are left alone. If any duplicate addresses came up during the day, close with a one-line reminder to run find_duplicates / clean them up on the Clients tab with Edit & Merge.
Also in your toolbox now: move_stop (up/down/position), remove_stop, set_stop_status (on_my_way / check_in / check_out / reset), optimize_route (nearest-neighbor reorder that keeps done stops in place), add_invoice_line. For last-minute add-ons, use find_nearby_properties or list_route_stops to recommend WHERE the new stop fits best, then move_stop it into position.`

function buildSystem(tone?: string | null): string {
  const key = (tone || DEFAULT_TONE).toLowerCase()
  return `${BASE_SYSTEM}\n\n${FIELD_OPS}\n\n${TONES[key] || TONES[DEFAULT_TONE]}`
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
        billing_type: { type: "string", enum: ["subscription", "one_time"], description: "'subscription' (recurring, default) or 'one_time' (single-payment / on-demand client)." },
        status: { type: "string", enum: ["active", "paused", "prospect"] },
      },
      required: ["name"],
    },
  },
  {
    name: "update_client",
    description: "Update any field on an existing customer's profile: name, contact details, status, notes summary, billing type, business line, or their arrival-text setting. Only provided fields change.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        name: { type: "string" },
        address: { type: "string", description: "The client's MAILING/billing address — service addresses live on properties (use add_property / edit_property for those)." },
        contact_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        notes: { type: "string", description: "Replaces the one-line notes summary. For a dated running note use add_client_note instead." },
        status: { type: "string", enum: ["active", "paused", "prospect"], description: "Setting 'paused' ALSO pauses all the client's addresses and pulls their pending stops off today's/future routes; 'active' unpauses all their addresses." },
        billing_type: { type: "string", enum: ["subscription", "one_time"], description: "Switch the client between subscription and single-payment." },
        business_line: { type: "string", enum: ["waste", "junk", "lawn"], description: "Which business line the client belongs to." },
        notify_on_service: { type: ["boolean", "null"], description: "Arrival-text setting: true=always text on check-in, false=never, null=auto (single-property clients only)." },
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
    description: "Add ONE new address as a stop on a route for a date. Finds the property (or creates it, tied to the client if given), geocodes the address, and appends the stop. If the address matches several existing properties it returns needs_clarification — ask the user which one. Defaults to today and the first route.",
    input_schema: {
      type: "object",
      properties: {
        route_code: { type: "string", description: "Route code/letter. Defaults to the first route." },
        date: { type: "string", description: "Service date YYYY-MM-DD. Defaults to today." },
        property_name: { type: "string", description: "Name/label for the stop" },
        address: { type: "string" },
        service: { type: "string" },
        client_name: { type: "string", description: "The owning client — disambiguates a shared address and ties a NEW property to the right client." },
        customer_id: { type: "string", description: "Exact client id (from find_clients), preferred over client_name." },
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
        pickup_day: { type: "string", description: "Legacy single pickup day. Prefer pickup_days (array)." },
        pickup_days: { type: "array", items: { type: "string" }, description: "Pickup day(s) applied to every property in this batch, e.g. ['tuesday','friday']. Full lowercase day names." },
        pickup_freq: { type: "string", description: "weekly | biweekly | monthly | on_call. Defaults to weekly." },
        billing_type: { type: "string", enum: ["subscription", "one_time"], description: "Set the CLIENT's billing type: 'subscription' for recurring service, 'one_time' for single-payment / on-demand clients." },
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
              days: { type: "array", items: { type: "string" }, description: "Pickup day(s) for THIS property (overrides the batch pickup_days) — lets one import mix Monday and Thursday addresses." },
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
      "Edit ONE existing property and/or clear its 'Needs review' flag. Find it by address (and optionally the client name to disambiguate). Use this to fix a flagged property the owner is reviewing — set the price, service, pickup day(s), or notes — or to correct the ADDRESS itself (new_address re-geocodes the pin). Set mark_reviewed:true to clear the flag once it's correct, needs_review:true to flag it.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address (or part of it) of the property to edit. Required unless property_id is given." },
        property_id: { type: "string", description: "Exact property id, if known. Use instead of address." },
        client_name: { type: "string", description: "Optional — the owning client, to disambiguate a shared address." },
        new_address: { type: "string", description: "CORRECTED street address (fixes a typo/wrong address; the map pin is re-geocoded)." },
        new_name: { type: "string", description: "New display name for the property." },
        price: { type: "number", description: "New price for this property." },
        service: { type: "string", description: "New service, e.g. 'Trash / Recycle'." },
        notes: { type: "string", description: "New bin-placement / access note." },
        pickup_days: { type: "array", items: { type: "string" }, description: "Full lowercase day names, e.g. ['monday','thursday']. Replaces the property's pickup days." },
        pickup_freq: { type: "string", description: "weekly | biweekly | monthly | on_call." },
        mark_reviewed: { type: "boolean", description: "True to clear the Needs review flag (property is now correct)." },
        needs_review: { type: "boolean", description: "True to flag this property for review. Ignored if mark_reviewed is set." },
        paused: { type: "boolean", description: "true PAUSES this address — pulls its pending stops off today's/future routes and keeps it off route builds until resumed. false resumes it. For a whole client use pause_properties." },
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
    name: "pause_properties",
    description:
      "PAUSE or RESUME service for MANY addresses in one shot — selected by client, tag, or address text. Pausing marks the properties paused AND pulls their pending (never checked-in) stops off today's and future routes; paused addresses are skipped by every route build until resumed. Use for 'take all of Acme's addresses off the routes' or 'we no longer service <client>'. Nothing is deleted — addresses are kept and recoverable. Resume with paused:false (they rejoin route builds on their pickup days). For a SINGLE address use edit_property with paused.",
    input_schema: {
      type: "object",
      properties: {
        by_customer: { type: "string", description: "Client/business name — affects all of that client's addresses." },
        by_customer_id: { type: "string", description: "Exact client id, if known." },
        by_tag: { type: "string", description: "Tag name — addresses of clients carrying this tag." },
        address_contains: { type: "string", description: "Match addresses whose address or name contains this text." },
        paused: { type: "boolean", description: "true = pause (default). false = resume service." },
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
    name: "skip_stop",
    description:
      "Mark a route stop SKIPPED for a date, with a reason (e.g. 'gate locked', 'client asked to skip this week'). The stop STAYS on the route flagged as skipped — nothing is deleted — so dispatch can see it was intentionally passed over. Use undo:true to un-skip (back to pending). Finds the stop by property address; date defaults to today.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address (or part of it) of the stop's property." },
        client_name: { type: "string", description: "Optional — the owning client, to disambiguate a shared address." },
        date: { type: "string", description: "Service date YYYY-MM-DD. Defaults to today." },
        route_code: { type: "string", description: "Optional — limit to one route code/letter." },
        reason: { type: "string", description: "Why it's being skipped. Strongly encouraged." },
        undo: { type: "boolean", description: "true to un-skip the stop (back to pending)." },
      },
      required: ["address"],
    },
  },
  {
    name: "move_pickup_once",
    description:
      "ONE-TIME day change: move one address's pickup off its regular date to another date WITHOUT changing the recurring schedule (e.g. 'skip Thursday and run them Friday, just this week'). Records a day override (route rebuilds respect it) and moves the already-built stop if there is one. Omit service_date for a pure one-time skip. For a PERMANENT day change use edit_property with pickup_days instead.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address (or part of it) of the property." },
        client_name: { type: "string", description: "Optional — the owning client, to disambiguate a shared address." },
        skip_date: { type: "string", description: "The regular date being moved/skipped, YYYY-MM-DD." },
        service_date: { type: "string", description: "The one-time date to run instead, YYYY-MM-DD. Omit to just skip." },
        note: { type: "string", description: "Short note, e.g. 'client asked — holiday'." },
      },
      required: ["address", "skip_date"],
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
      "List the services the company offers — each with how many properties use it (usage) and a possible_duplicates list flagging near-identical names (case/spacing variants). Derived from the service recorded on each property. Use when asked 'what services do we offer?'. When answering, give just the list of names — no descriptions or commentary per item.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "merge_service",
    description:
      "Bulk-rename, merge, or clear a SERVICE across many properties at once — the fix for duplicate or messy service names. Sets the service field on every property currently using from_service (case-insensitive exact match) to a new value. Use to merge duplicates ('change everything using \"Combo Service\" to \"Combo\"'), swap one service for another ('switch all \"Weekly trash pick up & removal - 1 day\" properties to \"1 weekly\"'), or clear a bad name (set clear:true). The app's service list is derived from these property values, so this is how you clean it up. Optionally scope to one client, or pass preview:true first to see how many properties would change before applying.",
    input_schema: {
      type: "object",
      properties: {
        from_service: { type: "string", description: "Exact current service name to change (case-insensitive). Get exact names from list_services." },
        to_service: { type: "string", description: "New service name to set on matching properties. Omit and set clear:true to unset instead." },
        clear: { type: "boolean", description: "True to CLEAR the service (set to none) on matching properties instead of renaming." },
        client_name: { type: "string", description: "Optional — only change this client's properties. Omit to apply across all clients." },
        preview: { type: "boolean", description: "If true, only report how many properties WOULD change, without changing anything." },
      },
      required: ["from_service"],
    },
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
  {
    name: "get_client_invoices",
    description:
      "Look up a specific client's invoices and what they still owe — their billing history. Returns each invoice (number, status, total, due date, paid date) plus the total outstanding. Use for 'what does <client> owe?', 'show me the Smith invoices', 'is Acme paid up?'. Give a client name or customer_id.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client/business name to look up." },
        customer_id: { type: "string", description: "Client id, if you already have it from find_clients." },
        include_paid: { type: "boolean", description: "Include already-paid invoices too (default true)." },
      },
    },
  },
  {
    name: "get_tech_pay",
    description:
      "Get an employee's pay and hours for a period — how much a tech/driver has earned and worked. Sums per-job pay for their completed stops (a stop counts once it has a check-in, a check-out AND a photo, or an approved override) and totals their clocked hours from timesheets. Use for 'how much does Jose get paid this week?', 'what has Marcus earned this month?', 'hours for the crew last week'. Omit the employee to get every tech's totals. Default period is this week (Sun–Sat).",
    input_schema: {
      type: "object",
      properties: {
        employee: { type: "string", description: "Employee/driver name or email. Omit for all techs." },
        period: { type: "string", enum: ["this_week", "last_week", "this_month", "last_month"], description: "Shortcut period. Defaults to this_week." },
        start_date: { type: "string", description: "Range start YYYY-MM-DD (use with end_date instead of period)." },
        end_date: { type: "string", description: "Range end YYYY-MM-DD (inclusive)." },
      },
    },
  },
  {
    name: "get_service_history",
    description:
      "Proof-of-service history for an address or client — recent visits with check-in and check-out times, how many photos were taken, whether the tech marked 'on my way', and GPS. Use for 'did we service 123 Main last week?', 'when were we last at the Palm Coast property?', 'show me proof we showed up for Acme'. Give an address (best) or a client name.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Service address (or part of it)." },
        client_name: { type: "string", description: "Client name — pulls visits across all their properties." },
        limit: { type: "number", description: "Max visits (default 20)." },
      },
    },
  },
  {
    name: "list_activity",
    description:
      "List recent activity-log entries — the running feed of what happened in the CRM (check-ins/outs, photos, invoices created/paid, clients added, texts sent, etc.). Use for 'what's happened today?', 'recent activity'. Optionally filter by type.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional activity type filter (e.g. 'check_in', 'invoice_paid')." },
        limit: { type: "number", description: "Max entries (default 30)." },
      },
    },
  },
  {
    name: "list_messages",
    description:
      "List recent text messages (SMS) sent or received — the message history. Use for 'what texts went out today?', 'did we hear back from <client>?', 'show me the last messages to that number'. Give a client name or phone to filter to one conversation, or omit for the latest across everyone.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Filter to one client's texts." },
        phone: { type: "string", description: "Filter to one phone number." },
        limit: { type: "number", description: "Max messages (default 25)." },
      },
    },
  },
  {
    name: "list_team",
    description:
      "List the team / staff roster — everyone with a login, their role (admin/staff), whether they're a driver, phone, email, and which business lines they work. Use for 'who's on the team?', 'which drivers do we have?', 'what's Jose's number?'.",
    input_schema: {
      type: "object",
      properties: {
        drivers_only: { type: "boolean", description: "If true, only staff flagged as drivers." },
      },
    },
  },
  {
    name: "list_quotes",
    description:
      "List quotes sent to clients through the portal — number, title, total, status, and who it's for. Use for 'what quotes are outstanding?', 'did <client> accept their quote?'. Optionally filter by client or status.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Filter to one client." },
        status: { type: "string", description: "Filter by status, e.g. 'sent', 'accepted', 'declined'." },
        limit: { type: "number", description: "Max quotes (default 25)." },
      },
    },
  },
  {
    name: "list_service_requests",
    description:
      "List service requests customers submitted through the portal (extra pickups, questions, issues) — the kind, message, status, and which client. Use for 'any new service requests?', 'what did customers ask for in the portal?'. Optionally filter by status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status, e.g. 'new', 'open', 'done'." },
        limit: { type: "number", description: "Max requests (default 25)." },
      },
    },
  },
  {
    name: "find_nearby_properties",
    description:
      "Rank EVERY address on file (any client, subscription or not, paused or not) by straight-line distance from a GPS point. Used by the drivers' Check My Location button. Returns the closest matches with client, price, pickup days, distance in feet/miles, and whether each is already on today's route (with stop id + check-in state). The SAME address entered under more than one client is collapsed into ONE match (the best copy — already on today's route, then unpaused, then scheduled today, then oldest), with the extras listed under other_copies for information only: never ask the driver to choose between them, just work the primary copy. Confirm the match with the driver — say the zip out loud when two genuinely different candidates are similar.",
    input_schema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Driver GPS latitude." },
        lng: { type: "number", description: "Driver GPS longitude." },
        limit: { type: "number", description: "Max matches (default 5, max 10)." },
        date: { type: "string", description: "YYYY-MM-DD for the on-route check (default today)." },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "set_stop_status",
    description:
      "Field status for one route stop: on_my_way (stamps + the app texts the client separately), check_in (arrived — starts service), check_out (done), or reset (back to pending, clears times). Identify the stop by stop_number (the visit number the user sees), stop_id, or address + date. Use check_in after the driver confirms a Check My Location match.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "on_my_way | check_in | check_out | reset" },
        stop_id: { type: "string", description: "route_stops id, when known." },
        stop_number: { type: "number", description: "The visit number shown in route lists (e.g. 'stop 8'). NOT a UUID." },
        address: { type: "string", description: "Match the stop by property address instead." },
        date: { type: "string", description: "YYYY-MM-DD (default today) when matching by address or stop_number." },
        route_code: { type: "string", description: "Optional — which route, when several run that day." },
      },
      required: ["status"],
    },
  },
  {
    name: "move_stop",
    description:
      "Reorder a stop within its route: direction 'up'/'down' one slot, or position N to drop it at a specific visit number. Renumbers the whole route. Identify the stop by stop_number (the visit number the user sees, e.g. 'stop 57'), address + date, or stop_id.",
    input_schema: {
      type: "object",
      properties: {
        stop_id: { type: "string", description: "route_stops UUID, when known." },
        stop_number: { type: "number", description: "The visit number shown in route lists / list_route_stops seq (e.g. 'move stop 57'). NOT a UUID." },
        address: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD (default today)." },
        route_code: { type: "string", description: "Optional — which route, when several run that day." },
        direction: { type: "string", description: "'up' or 'down' (one slot)." },
        position: { type: "number", description: "Target visit number (1-based) — overrides direction." },
      },
    },
  },
  {
    name: "remove_stop",
    description:
      "Take one stop OFF its route (the address/property itself is kept). Identify by stop_number (the visit number the user sees), stop_id, or address + date. For skipping with a reason use skip_stop instead; for wholesale end-of-day cleanup use cleanup_unconfirmed_stops.",
    input_schema: {
      type: "object",
      properties: {
        stop_id: { type: "string", description: "route_stops UUID, when known." },
        stop_number: { type: "number", description: "The visit number shown in route lists (e.g. 'remove stop 12'). NOT a UUID." },
        address: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD (default today)." },
        route_code: { type: "string", description: "Optional — which route, when several run that day." },
      },
    },
  },
  {
    name: "add_invoice_line",
    description:
      "Append a line to the client's CURRENT-MONTH DRAFT invoice (creates the draft if none exists), updating totals. Used per confirmed visit in field mode and for one-time stops; the draft is sent at month end. Give customer_id or client_name, a description, and the amount.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        client_name: { type: "string" },
        description: { type: "string", description: "e.g. 'Valet trash — 1711 Main St — 2026-08-10'" },
        amount: { type: "number", description: "Dollar amount for this line." },
      },
      required: ["description", "amount"],
    },
  },
  {
    name: "pin_stop",
    description:
      "Pin the route stop the user means, immediately after you resolve it (from GPS, an address, or a stop number). The pin carries across turns: follow-ups like 'do it', 'skip it', 'check in there', 'that one' should pass this stop_id directly instead of searching again. Call it the moment you know which stop they mean.",
    input_schema: {
      type: "object",
      properties: {
        stop_id: { type: "string", description: "route_stops id (required)." },
        stop_number: { type: "number", description: "The visit number (seq) shown in route lists." },
        address: { type: "string", description: "The FULL stored address, verbatim." },
        route_code: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD of the stop's route." },
      },
      required: ["stop_id"],
    },
  },
  {
    name: "pin_property",
    description:
      "Pin the property (service address) the user means, immediately after you resolve it. Later turns can pass this property_id directly instead of re-searching.",
    input_schema: {
      type: "object",
      properties: {
        property_id: { type: "string", description: "properties id (required)." },
        address: { type: "string", description: "The FULL stored address, verbatim." },
        client_name: { type: "string" },
      },
      required: ["property_id"],
    },
  },
  {
    name: "propose_action",
    description:
      "For the rare risky action that needs one read-back (remove a stop, text/email a customer, delete data, business-wide settings): call this INSTEAD of executing, with the exact tool name and fully-resolved input you would use, then tell the user in one short sentence what you're about to do. If they say yes, execute exactly this input. Never use this for routine actions — those execute immediately.",
    input_schema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "The tool that would run (e.g. remove_stop, send_sms)." },
        input: { type: "object", description: "The exact arguments, with resolved ids included." },
      },
      required: ["tool", "input"],
    },
  },
  {
    name: "undo_last_action",
    description:
      "Reverse the most recent field action (by you or the app): status changes, check-ins/outs, skips, moves, removed stops, route reorders, one-time day changes. Use when the user says 'undo that', 'reverse it', 'put it back'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cleanup_unconfirmed_stops",
    description:
      "End-of-day data cleanup: list route stops for a date that were never checked in (skipped stops are left alone). Call WITHOUT confirm first — it changes nothing and returns the list; read it back to the user. Only after an explicit YES call again with confirm=true, which removes those stops from the route AND pauses their addresses (recoverable on the Clients screen — nothing is deleted).",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD (default today)." },
        route_code: { type: "string", description: "Limit to one route code; omit for all routes that date." },
        confirm: { type: "boolean", description: "false/omitted = preview only. true = actually remove + pause." },
      },
    },
  },
  {
    name: "optimize_route",
    description:
      "Reorder a date's route by nearest-neighbor driving order: starts from the depot (or the last completed stop), keeps already checked-in/done stops in their current position, and renumbers the rest by proximity. Returns the new visit order. Stops with no coordinates go to the end.",
    input_schema: {
      type: "object",
      properties: {
        route_code: { type: "string", description: "Route code, e.g. 'A'." },
        date: { type: "string", description: "YYYY-MM-DD (default today)." },
      },
      required: ["route_code"],
    },
  },
  {
    name: "add_property",
    description:
      "Add ONE new service address (property) under an existing client. Use for 'add 123 Oak St to Acme' / 'they have a new address'. Geocodes the address immediately. For MANY addresses at once use bulk_add_properties instead. To change an existing address use edit_property.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "The client's id (preferred — from find_clients)." },
        client_name: { type: "string", description: "Client name, if you don't have the id." },
        address: { type: "string", description: "Full street address of the new property." },
        name: { type: "string", description: "Optional display name (e.g. 'Building B')." },
        price: { type: "number", description: "Monthly (or per-visit) price for this address." },
        service: { type: "string", description: "Service, e.g. 'Trash / Recycle'." },
        pickup_days: { type: "array", items: { type: "string" }, description: "Full lowercase day names, e.g. ['monday','thursday']." },
        pickup_freq: { type: "string", description: "weekly | biweekly | monthly | on_call (default weekly)." },
        notes: { type: "string", description: "Bin placement / access note." },
        needs_review: { type: "boolean", description: "True to flag it for review (uncertain data)." },
      },
      required: ["address"],
    },
  },
  {
    name: "untag_client",
    description: "Remove a tag from a customer (the tag itself stays in the tag list). Use for 'take the North Side tag off Acme'.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        tag: { type: "string", description: "Tag label to remove from this client." },
      },
      required: ["customer_id", "tag"],
    },
  },
  {
    name: "list_tags",
    description: "List every tag with its color and how many clients carry it. Use for 'what tags do we have?' or before renaming/merging tags.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "edit_tag",
    description:
      "Rename, recolor, or DELETE a tag everywhere it's used (tags are shared — renaming updates every client carrying it; deleting removes it from all clients). Use for 'rename Northside to North Side', 'make the VIP tag gold', 'delete the old-pricing tag'.",
    input_schema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Current tag label." },
        new_name: { type: "string", description: "New label (rename)." },
        color: { type: "string", description: "New hex color like #b07a1e." },
        delete: { type: "boolean", description: "True to delete the tag entirely (removes it from every client)." },
      },
      required: ["tag"],
    },
  },
  {
    name: "add_client_note",
    description:
      "Add a dated note to a client's running notes log (shown newest-first on their client record). Use for 'note on Acme: gate code changed to 4482' or after a call worth recording. This is the notes LOG — for replacing the one-line summary field use update_client notes.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "The client's id (preferred)." },
        client_name: { type: "string", description: "Client name, if you don't have the id." },
        note: { type: "string", description: "The note text (keep it clean — it's on the client's record)." },
        author: { type: "string", description: "Staff member the note is from, if they said so (default: Trashy Randy)." },
      },
      required: ["note"],
    },
  },
  {
    name: "list_client_notes",
    description: "Read a client's notes log, newest first. Use for 'any notes on Acme?' / 'what's the history with this client?'.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        client_name: { type: "string" },
        limit: { type: "number", description: "Max notes (default 15)." },
      },
    },
  },
  {
    name: "set_randy_tone",
    description:
      "Change YOUR OWN chat personality (the Settings › Randy tone). Takes effect from the next reply. Use when staff say 'tone it down', 'be professional', 'go full spicy', etc.",
    input_schema: {
      type: "object",
      properties: {
        tone: { type: "string", enum: ["spicy", "funny", "friendly", "professional", "hype", "deadpan"], description: "The new personality." },
      },
      required: ["tone"],
    },
  },
  {
    name: "set_depot",
    description:
      "Set the depot / starting location (the yard) used as the route map's home pin and the optimizer's start point. Geocodes the address. BUSINESS-WIDE setting: read the address back and get an explicit yes BEFORE calling this.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Full street address of the yard / starting location." },
        name: { type: "string", description: "Display name (default 'Yard')." },
      },
      required: ["address"],
    },
  },
  {
    name: "get_message_templates",
    description:
      "Read the editable SMS message templates from Settings (check-in arrival, check-out complete, reminder, invoice) plus the company name, with the {token} placeholders each supports. Use before editing a template or when asked 'what does the arrival text say?'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_message_template",
    description:
      "Rewrite one of the Settings SMS templates (checkin | checkout | reminder | invoice) or the company name. Templates are CUSTOMER-FACING — keep them clean and professional. BUSINESS-WIDE setting: read the exact new text back and get an explicit yes BEFORE calling this. Supported tokens: {customerName} {serviceType} {address} {companyName}, plus {invoiceNumber} {total} {payLink} on the invoice template.",
    input_schema: {
      type: "object",
      properties: {
        template: { type: "string", enum: ["checkin", "checkout", "reminder", "invoice", "company_name"], description: "Which template (or company_name) to set." },
        text: { type: "string", description: "The full new template text (with {tokens}), or the new company name." },
      },
      required: ["template", "text"],
    },
  },
  {
    name: "get_portal_status",
    description:
      "Everything about a client's PORTAL: their permanent portal link, whether they've ever logged in (and when last seen), saved card + autopay consent, balance due, open quotes, open service requests, and any 5th-week-free credits already applied. Use for 'has Acme set up their portal?', 'do they have a card on file?', 'what's in their portal?'.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        client_name: { type: "string" },
      },
    },
  },
  {
    name: "invite_portal",
    description:
      "Invite a client to their customer portal with the 5th-week-free pitch: texts them a one-time login link (good for 7 days) explaining that saving a card for autopay makes every 5th pickup week in a month FREE. Falls back to email when the client has no phone. Use for 'invite Acme to the portal', 'send them the 5th week free offer'.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        client_name: { type: "string" },
        custom_message: { type: "string", description: "Optional custom SMS text; supports {customerName} {companyName} {link} tokens. Omit for the standard pitch. Must be clean/professional." },
      },
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

// Best-effort undo log (0052): every mutating field action snapshots its
// before-state so undo_latest()/the ↩ button can reverse it. Never throws.
async function logUndo(actionType: string, entityId: string | null, before: unknown, after?: unknown) {
  try {
    await sbPost("undoable_actions", {
      source: "randy",
      actor: "Trashy Randy",
      action_type: actionType,
      entity_table: entityId ? "route_stops" : null,
      entity_id: entityId,
      before,
      after: after ?? null,
    })
  } catch (_) { /* undo is best-effort; the action itself must not fail */ }
}

// The route_stops fields undo_action() restores, as a PostgREST select.
const UNDO_SELECT =
  "id,route_id,seq,status,check_in,check_out,check_in_lat,check_in_lng,check_out_lat,check_out_lng,on_my_way_at,skip_reason,skipped_by,skipped_at,property_id"
async function snapshotStop(stopId: string): Promise<any | null> {
  try {
    const r = await sbGet(`route_stops?id=eq.${enc(stopId)}&select=${UNDO_SELECT}`)
    return r[0] ?? null
  } catch (_) { return null }
}

async function undoLastActionTool(): Promise<unknown> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/undo_latest`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_source: "randy", p_within_minutes: 240, p_undone_by: "Trashy Randy" }),
  })
  if (!r.ok) throw new Error(`undo_latest: ${r.status} ${await r.text()}`)
  return await r.json()
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
    case "pause_properties": return out.changed ? logActivity("properties_paused", `${out.paused ? "Paused" : "Resumed"} ${out.changed} address${out.changed === 1 ? "" : "es"}${out.stops_removed ? ` (${out.stops_removed} stops off routes)` : ""}`, "customer") : undefined
    case "add_property_photo": return out.needs_clarification ? undefined : logActivity("property_photo_added", `Logged a ${out.date} photo on ${out.address}`, "property", out.id)
    case "skip_stop": return out.ok ? logActivity(out.undone ? "stop_unskipped" : "stop_skipped", `${out.undone ? "Un-skipped" : "Skipped"} ${out.address} (${out.date})${out.reason ? ` — ${out.reason}` : ""}`, "property", out.property_id) : undefined
    case "move_pickup_once": return out.ok ? logActivity("day_changed_once", `One-time move: ${out.address} off ${out.skip_date}${out.service_date ? ` → ${out.service_date}` : " (skipped)"}`, "property", out.property_id) : undefined
    case "send_sms": return out.ok ? logActivity("sms_sent", `Texted ${out.to}`) : undefined
    case "text_invoice": return out.ok ? logActivity(out.preview ? "invoice_previewed" : "invoice_texted", out.preview ? `Previewed invoice ${out.invoice} to ${out.sent_to}` : `Texted invoice ${out.invoice} to ${out.client}`, "invoice") : undefined
    case "suggest_automation": return out.ok ? logActivity("automation_suggested", `Suggested automation: ${out.name}${out.admins_texted ? ` (texted ${out.admins_texted} admin${out.admins_texted === 1 ? "" : "s"})` : ""}`) : undefined
    case "add_property": return out.ok ? logActivity("property_added", `Added ${out.address} under ${out.client}`, "property", out.id) : undefined
    case "untag_client": return out.ok ? logActivity("client_untagged", `Removed tag "${out.tag}" from a client`, "customer", out.customer_id) : undefined
    case "edit_tag": return out.ok ? logActivity("tag_edited", out.deleted ? `Deleted tag "${out.deleted}"` : `Tag "${out.was}" → "${out.tag}"`) : undefined
    case "add_client_note": return out.ok ? logActivity("client_note_added", `Note on ${out.client}: ${String(out.note).slice(0, 80)}`, "customer", out.customer_id) : undefined
    case "set_randy_tone": return out.ok ? logActivity("settings", `Randy tone set to ${out.tone}`, "app_settings", "1") : undefined
    case "set_depot": return out.ok ? logActivity("settings", `Depot / starting location set to ${out.depot}`, "app_settings", "1") : undefined
    case "set_message_template": return out.ok ? logActivity("settings", `Updated the ${out.template} SMS template`, "app_settings", "1") : undefined
    case "invite_portal": return out.ok ? logActivity("portal_invited", `Portal invite (5th week free) sent to ${out.client} via ${out.via}`, "customer") : undefined
    case "create_job": return out.ok ? logActivity("job_created", `Scheduled a job${out.address ? ` at ${out.address}` : ""} for ${out.date}`, "job", out.id) : undefined
    case "merge_service": return out.changed ? logActivity("service_merged", `Changed ${out.changed} propert${out.changed === 1 ? "y" : "ies"} from \"${out.from}\" to ${out.to == null ? "(none)" : `\"${out.to}\"`}`, "property") : undefined
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
// Business timezone, NOT UTC: the edge runtime rolls to a new day at 8pm ET,
// which made every "today" default resolve to tomorrow's unbuilt routes all
// evening. en-CA dateStyle gives YYYY-MM-DD.
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", dateStyle: "short" }).format(new Date())

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
    billing_type: a.billing_type ?? "subscription",
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
  for (const k of ["name", "address", "contact_name", "email", "phone", "notes", "status", "billing_type", "business_line", "notify_on_service"]) {
    if (a[k] !== undefined) patch[k] = a[k]
  }
  if (Object.keys(patch).length === 0) throw new Error("No fields to update.")
  const [row] = await sbPatch(`customers?id=eq.${enc(a.customer_id)}`, patch)
  if (!row) throw new Error("Customer not found.")
  const out: any = { id: row.id, name: row.name, updated: Object.keys(patch) }
  // Client status cascades to their addresses — otherwise the daily route build
  // (which only checks properties.paused) keeps putting a "paused" client's
  // stops right back on the routes.
  if (patch.status === "paused") {
    const props = await sbGet(`properties?customer_id=eq.${enc(row.id)}&paused=eq.false&select=id`)
    const ids = props.map((p: any) => p.id)
    for (let i = 0; i < ids.length; i += 100) {
      await sbPatch(`properties?id=in.(${ids.slice(i, i + 100).join(",")})`, { paused: true })
    }
    out.addresses_paused = ids.length
    out.stops_removed = await pullPendingStops(ids)
    out.note = "Client paused — all their addresses are paused and their pending stops pulled off today's/future routes (recoverable)."
  } else if (patch.status === "active") {
    const props = await sbGet(`properties?customer_id=eq.${enc(row.id)}&paused=eq.true&select=id`)
    const ids = props.map((p: any) => p.id)
    for (let i = 0; i < ids.length; i += 100) {
      await sbPatch(`properties?id=in.(${ids.slice(i, i + 100).join(",")})`, { paused: false })
    }
    out.addresses_resumed = ids.length
    if (ids.length) out.note = "Client active — their addresses are unpaused and rejoin route builds on their pickup days."
  }
  return out
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
  const address = String(a.address ?? "").trim()

  // Resolve the client, when given (ties a NEW property to the right customer
  // and disambiguates addresses shared across clients).
  let customerId: string | null = a.customer_id ?? null
  if (!customerId && a.client_name) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${a.client_name}*`)}&select=id,name&limit=5`)
    if (custs.length === 1) customerId = custs[0].id
    else if (custs.length > 1) {
      return { needs_clarification: true, which: "client", matches: custs.map((c: any) => ({ id: c.id, name: c.name })) }
    }
  }

  // property by address (create if missing) — geocode best-effort
  let props = await sbGet(`properties?address=ilike.${enc(`*${address}*`)}&select=id,name,address,service,lat,lng,customer_id&limit=10`)
  if (customerId && props.length > 1) props = props.filter((p: any) => p.customer_id === customerId)
  if (props.length > 1) {
    return { needs_clarification: true, which: "property", matches: props.map((p: any) => ({ id: p.id, address: p.address || p.name })) }
  }
  let property = props[0]
  if (!property) {
    const loc = await geocode(address)
    const [p] = await sbPost("properties", {
      name: a.property_name ?? address,
      address,
      service: a.service ?? null,
      customer_id: customerId,
      created_by: "Trashy Randy",
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
    })
    property = p
  }
  const route = await ensureRoute(code, date)
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
        pickup_days: Array.isArray(a.pickup_days) ? a.pickup_days : undefined,
        pickup_freq: a.pickup_freq ?? "weekly",
        billing_type: a.billing_type ?? null,
        needs_review: a.needs_review ?? false,
        created_by: "Trashy Randy",
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
  if (a.new_address !== undefined && String(a.new_address).trim()) {
    const newAddr = String(a.new_address).trim()
    patch.address = newAddr
    const loc = await geocode(newAddr)
    patch.lat = loc?.lat ?? null
    patch.lng = loc?.lng ?? null
  }
  if (a.new_name !== undefined) patch.name = a.new_name
  if (a.price !== undefined) patch.price = a.price
  if (a.service !== undefined) patch.service = a.service
  if (a.notes !== undefined) patch.notes = a.notes
  if (Array.isArray(a.pickup_days)) patch.pickup_days = a.pickup_days
  if (a.pickup_freq !== undefined) patch.pickup_frequency = a.pickup_freq
  if (a.mark_reviewed === true) patch.needs_review = false
  else if (a.needs_review !== undefined) patch.needs_review = a.needs_review
  if (a.paused !== undefined) patch.paused = !!a.paused
  if (Object.keys(patch).length === 0) throw new Error("Nothing to change — specify a field to update or mark_reviewed.")
  const [row] = await sbPatch(`properties?id=eq.${enc(propId)}`, patch)
  if (!row) throw new Error("Property not found.")
  const out: any = {
    id: row.id,
    address: row.address || row.name,
    updated: Object.keys(patch),
    needs_review: row.needs_review,
  }
  if (patch.paused === true) {
    out.stops_removed = await pullPendingStops([row.id])
    out.note = "Paused — off today's and future routes until resumed (address kept)."
  } else if (patch.paused === false) {
    out.note = "Resumed — back on route builds for its pickup days."
  }
  return out
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

// Delete pending, never-checked-in stops for these properties from today's and
// future routes. Past routes are history and are left alone; checked-in/done/
// skipped stops are never touched.
async function pullPendingStops(propIds: string[]): Promise<number> {
  if (!propIds.length) return 0
  const routes = await sbGet(`routes?service_date=gte.${enc(today())}&select=id`)
  if (!routes.length) return 0
  const routeIds = routes.map((r: any) => enc(r.id)).join(",")
  let pulled = 0
  for (let i = 0; i < propIds.length; i += 100) {
    const chunk = propIds.slice(i, i + 100).map((id) => enc(id)).join(",")
    const stops = await sbGet(`route_stops?route_id=in.(${routeIds})&property_id=in.(${chunk})&status=eq.pending&check_in=is.null&select=id`)
    for (const s of stops) {
      await sbDel(`route_stops?id=eq.${enc(s.id)}`)
      pulled++
    }
  }
  return pulled
}

async function pauseProperties(a: any) {
  if (!a.by_customer && !a.by_customer_id && !a.by_tag && !a.address_contains) {
    throw new Error("Tell me which addresses to pause/resume — by client, tag, or address.")
  }
  const ids = await resolvePropertyIds(a)
  const want = a.paused !== false // default: pause
  if (!ids.length) return { matched: 0, changed: 0, paused: want, stops_removed: 0 }
  let changed = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const rows = await sbPatch(`properties?id=in.(${chunk.join(",")})`, { paused: want })
    changed += rows.length
  }
  const stopsRemoved = want ? await pullPendingStops(ids) : 0
  return {
    matched: ids.length,
    changed,
    paused: want,
    stops_removed: stopsRemoved,
    note: want
      ? "Paused — pulled off today's/future routes and skipped by route builds until resumed (addresses kept; checked-in stops untouched)."
      : "Resumed — they rejoin route builds on their pickup days.",
  }
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

// Find the route_stops row for a property on a date (optionally one route code).
async function findStopFor(propertyId: string, date: string, routeCode?: string) {
  let rq = `routes?service_date=eq.${enc(date)}&select=id,code`
  if (routeCode) rq += `&code=eq.${enc(String(routeCode).trim().toUpperCase())}`
  const routes = await sbGet(rq)
  if (!routes.length) return null
  const ids = routes.map((r: any) => r.id)
  const stops = await sbGet(`route_stops?route_id=in.(${ids.join(",")})&property_id=eq.${enc(propertyId)}&select=id,route_id,status,seq&limit=2`)
  if (!stops.length) return null
  const stop = stops[0]
  const route = routes.find((r: any) => r.id === stop.route_id)
  return { ...stop, route_code: route?.code ?? null }
}

// Skip (or un-skip) a stop with a reason — flagged, never deleted.
async function skipStopTool(a: any) {
  const date = a.date ? String(a.date).trim() : today()
  const prop = await resolveOneProperty(a)
  if (prop.needs_clarification) return prop
  const stop = await findStopFor(prop.id, date, a.route_code)
  if (!stop) return { ok: false, note: `No stop for ${prop.address} on ${date} — the route may not be built yet.` }
  if (a.undo) {
    const before = await snapshotStop(stop.id)
    await sbPatch(`route_stops?id=eq.${enc(stop.id)}`, { status: "pending", skip_reason: null, skipped_by: null, skipped_at: null })
    await logUndo("stop_status", stop.id, before)
    return { ok: true, undone: true, address: prop.address, property_id: prop.id, date, route: stop.route_code }
  }
  if (stop.status === "done") return { ok: false, note: `${prop.address} is already checked out (done) on ${date} — nothing to skip.` }
  const before = await snapshotStop(stop.id)
  await sbPatch(`route_stops?id=eq.${enc(stop.id)}`, {
    status: "skipped",
    skip_reason: (a.reason ?? "").trim() || null,
    skipped_by: "Trashy Randy",
    skipped_at: new Date().toISOString(),
  })
  await logUndo("stop_status", stop.id, before)
  return { ok: true, address: prop.address, property_id: prop.id, date, route: stop.route_code, reason: (a.reason ?? "").trim() || null }
}

// One-time day change: record the override, then move/skip the built stop.
async function movePickupOnce(a: any) {
  const skipDate = String(a.skip_date ?? "").trim()
  if (!skipDate) throw new Error("skip_date (the regular date being moved) is required.")
  const serviceDate = a.service_date ? String(a.service_date).trim() : null
  const prop = await resolveOneProperty(a)
  if (prop.needs_clarification) return prop
  const [override] = await sbPost("property_day_overrides", {
    property_id: prop.id,
    skip_date: skipDate,
    service_date: serviceDate,
    note: (a.note ?? "").trim() || null,
    created_by: "Trashy Randy",
  })
  // If the skip_date route is already built, move (or skip) the live stop too.
  let stopAction = "no built stop on that date yet — the override will apply when the route is built"
  const stop = await findStopFor(prop.id, skipDate)
  let before: any = null
  if (stop && stop.status !== "done") {
    before = await snapshotStop(stop.id)
    if (serviceDate) {
      const target = await ensureRoute(stop.route_code || await defaultRouteCode(), serviceDate)
      const existing = await sbGet(`route_stops?route_id=eq.${enc(target.id)}&select=seq`)
      const seq = nextSeqFrom(existing) + 1
      await sbPatch(`route_stops?id=eq.${enc(stop.id)}`, { route_id: target.id, seq })
      stopAction = `moved the built stop to ${serviceDate}`
    } else {
      await sbPatch(`route_stops?id=eq.${enc(stop.id)}`, {
        status: "skipped",
        skip_reason: (a.note ?? "").trim() || "One-time skip",
        skipped_by: "Trashy Randy",
        skipped_at: new Date().toISOString(),
      })
      stopAction = "marked the built stop skipped"
    }
  }
  // Undo = delete the override row + restore the built stop's prior placement.
  await logUndo("day_override", stop?.id ?? null, { override_id: override?.id ?? null, stop: before })
  return { ok: true, address: prop.address, property_id: prop.id, skip_date: skipDate, service_date: serviceDate, stop_action: stopAction, note: "Recurring schedule unchanged — this applies to that one date only." }
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
  const rows = await sbGet(`properties?select=service&limit=5000`)
  const counts: Record<string, number> = {}
  for (const r of rows) {
    const v = String(r.service ?? "").trim()
    if (!v) continue
    counts[v] = (counts[v] || 0) + 1
  }
  const usage = Object.entries(counts)
    .map(([service, properties]) => ({ service, properties }))
    .sort((a, b) => b.properties - a.properties || a.service.localeCompare(b.service))
  const services = usage.map((u) => u.service)
  // Flag likely duplicates: same value ignoring case / extra spacing.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  const byNorm: Record<string, string[]> = {}
  for (const s of services) (byNorm[norm(s)] ||= []).push(s)
  const possible_duplicates = Object.values(byNorm).filter((g) => g.length > 1)
  if (!services.length) return { count: 0, services: [], note: "No services recorded on properties yet." }
  return { count: services.length, services, usage, ...(possible_duplicates.length ? { possible_duplicates } : {}) }
}

// Bulk rename / merge / clear a service across many properties (the fix for
// duplicate service names). Services are derived from properties.service.
async function mergeService(a: any) {
  const from = String(a.from_service ?? "").trim()
  if (!from) return { error: "Tell me which service to change (from_service)." }
  const clear = a.clear === true || a.to_service === null
  const to = a.to_service == null ? "" : String(a.to_service).trim()
  if (!clear && !to) return { error: "Give me the new service name (to_service), or set clear:true to unset it." }
  let scope = ""
  let scopeLabel = "all clients"
  if (a.client_name) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${String(a.client_name).trim()}*`)}&select=id,name&limit=25`)
    if (!custs.length) return { error: `No client matches "${a.client_name}".` }
    scope = `&customer_id=in.(${custs.map((c: any) => c.id).join(",")})`
    scopeLabel = custs.length === 1 ? custs[0].name : `${custs.length} matching clients`
  }
  // Case-insensitive EXACT match on the whole value (escape ilike wildcards).
  const esc = from.replace(/([%_])/g, "\\$1")
  const matchFilter = `service=ilike.${enc(esc)}`
  const matches = await sbGet(`properties?${matchFilter}${scope}&select=id&limit=5000`)
  if (!matches.length) return { from, matched: 0, changed: 0, note: `No properties are using "${from}"${a.client_name ? ` for ${scopeLabel}` : ""}.` }
  if (a.preview) {
    return { preview: true, from, to: clear ? null : to, scope: scopeLabel, matched: matches.length, note: `${matches.length} propert${matches.length === 1 ? "y" : "ies"} would change. Call again without preview to apply.` }
  }
  const ids = matches.map((m: any) => m.id)
  let changed = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const patched = await sbPatch(`properties?id=in.(${chunk.join(",")})`, { service: clear ? null : to })
    changed += patched.length
  }
  return { from, to: clear ? null : to, scope: scopeLabel, matched: matches.length, changed }
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
    // Ping the admins so suggestions don't sit unseen on the Automations tab.
    const pinged = await textAdmins(
      `🤖 Trashy Randy suggested a new automation: "${name}"${a.description ? ` — ${String(a.description).slice(0, 220)}` : ""}. Review + approve it on the Automations tab.`,
    )
    return {
      ok: true,
      id: rows?.[0]?.id,
      name,
      admins_texted: pinged,
      note: `Logged as suggested${pinged ? ` and texted ${pinged} admin${pinged === 1 ? "" : "s"}` : ""} — staff approve it on the Automations tab.`,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("duplicate") || msg.includes("23505")) return { error: "An automation like that is already on the Automations tab." }
    throw e
  }
}

// ---- SMS every admin (best-effort, mirrors the portal fn's textAdmins) ------
async function textAdmins(body: string): Promise<number> {
  let sent = 0
  try {
    const staff = await sbGet(`profiles?select=full_name,phone,role&phone=not.is.null&role=eq.admin`)
    for (const s of staff) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send", to: s.phone, body, purpose: "manual", sentBy: "Trashy Randy" }),
        })
        const d = await r.json().catch(() => ({}))
        if (d?.ok) sent++
      } catch (_e) { /* keep going */ }
    }
  } catch (_e) { /* SMS is best-effort */ }
  return sent
}

// ---- single-property add ----------------------------------------------------
async function addProperty(a: any) {
  const address = String(a.address || "").trim()
  if (!address) throw new Error("An address is required.")
  const client = await resolveClient(a)
  if (client.error || client.needs_clarification) return client
  // Duplicate guard: same address already under this client?
  const dupes = await sbGet(`properties?customer_id=eq.${enc(client.id)}&address=ilike.${enc(`*${address}*`)}&select=id,address&limit=3`)
  if (dupes.length) {
    return { error: `${client.name} already has a property matching "${dupes[0].address}". Use edit_property to change it, or give a different address.` }
  }
  const loc = await geocode(address)
  const [p] = await sbPost("properties", {
    customer_id: client.id,
    address,
    name: a.name ?? address,
    price: a.price ?? null,
    service: a.service ?? null,
    notes: a.notes ?? null,
    pickup_days: Array.isArray(a.pickup_days) ? a.pickup_days.map((d: string) => String(d).toLowerCase()) : null,
    pickup_frequency: a.pickup_freq ?? "weekly",
    needs_review: a.needs_review ?? false,
    created_by: "Trashy Randy",
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
  })
  return {
    ok: true,
    id: p.id,
    client: client.name,
    customer_id: client.id,
    address: p.address,
    geocoded: !!loc,
    note: loc ? undefined : "Couldn't geocode that address — the map pin will be placed when the address is corrected or the Import screen's geocoder runs.",
  }
}

// ---- tag management ---------------------------------------------------------
async function resolveTag(label: string) {
  const name = String(label || "").trim()
  if (!name) throw new Error("Tag label required.")
  const rows = await sbGet(`tags?name=ilike.${enc(name)}&select=id,name,color&limit=2`)
  if (!rows.length) throw new Error(`No tag named "${name}".`)
  return rows[0]
}

async function untagClient(a: any) {
  const tag = await resolveTag(a.tag)
  await sbDel(`customer_tags?customer_id=eq.${enc(a.customer_id)}&tag_id=eq.${enc(tag.id)}`)
  return { ok: true, tag: tag.name, customer_id: a.customer_id }
}

async function listTagsTool() {
  const tags = await sbGet(`tags?select=id,name,color&order=name.asc`)
  const links = await sbGet(`customer_tags?select=tag_id`)
  const counts: Record<string, number> = {}
  for (const l of links) counts[l.tag_id] = (counts[l.tag_id] || 0) + 1
  return { count: tags.length, tags: tags.map((t: any) => ({ name: t.name, color: t.color, clients: counts[t.id] || 0 })) }
}

async function editTag(a: any) {
  const tag = await resolveTag(a.tag)
  if (a.delete === true) {
    await sbDel(`customer_tags?tag_id=eq.${enc(tag.id)}`)
    await sbDel(`tags?id=eq.${enc(tag.id)}`)
    return { ok: true, deleted: tag.name }
  }
  const patch: Record<string, unknown> = {}
  if (a.new_name !== undefined && String(a.new_name).trim()) patch.name = String(a.new_name).trim()
  if (a.color !== undefined) {
    const c = String(a.color).trim()
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error("Color must be a hex value like #1f7a4d.")
    patch.color = c
  }
  if (!Object.keys(patch).length) throw new Error("Nothing to change — give a new_name, color, or delete:true.")
  const [row] = await sbPatch(`tags?id=eq.${enc(tag.id)}`, patch)
  return { ok: true, tag: row.name, color: row.color, was: tag.name }
}

// ---- client notes log -------------------------------------------------------
async function addClientNote(a: any) {
  const body = String(a.note || "").trim()
  if (!body) throw new Error("The note text is required.")
  const client = await resolveClient(a)
  if (client.error || client.needs_clarification) return client
  const [row] = await sbPost("client_notes", {
    customer_id: client.id,
    author_name: a.author ? String(a.author).trim() : "Trashy Randy",
    body,
  })
  return { ok: true, id: row.id, client: client.name, customer_id: client.id, note: body }
}

async function listClientNotes(a: any) {
  const client = await resolveClient(a)
  if (client.error || client.needs_clarification) return client
  const limit = Number(a.limit) > 0 ? Math.min(Math.floor(Number(a.limit)), 50) : 15
  const rows = await sbGet(`client_notes?customer_id=eq.${enc(client.id)}&select=author_name,body,created_at&order=created_at.desc&limit=${limit}`)
  return {
    client: client.name,
    count: rows.length,
    notes: rows.map((n: any) => ({ date: String(n.created_at).slice(0, 10), by: n.author_name || "staff", note: n.body })),
  }
}

// ---- settings: tone, depot, message templates -------------------------------
const VALID_TONES = ["spicy", "funny", "friendly", "professional", "hype", "deadpan"]

async function setRandyTone(a: any) {
  const tone = String(a.tone || "").toLowerCase().trim()
  if (!VALID_TONES.includes(tone)) throw new Error(`Tone must be one of: ${VALID_TONES.join(", ")}.`)
  await sbPatch(`app_settings?id=eq.1`, { randy_tone: tone, updated_at: new Date().toISOString() })
  return { ok: true, tone, note: `Tone set to ${tone} — it kicks in from my next reply. (Customer-facing text stays clean regardless.)` }
}

async function setDepot(a: any) {
  const address = String(a.address || "").trim()
  if (!address) throw new Error("The depot address is required.")
  const loc = await geocode(address)
  if (!loc) throw new Error(`Couldn't geocode "${address}" — double-check the address (street, city, zip).`)
  await sbPatch(`app_settings?id=eq.1`, {
    depot_name: a.name ? String(a.name).trim() : "Yard",
    depot_address: address,
    depot_lat: loc.lat,
    depot_lng: loc.lng,
    updated_at: new Date().toISOString(),
  })
  return { ok: true, depot: address, lat: loc.lat, lng: loc.lng, note: "Depot updated — the route map's home pin and the optimizer's start point now use this location." }
}

const TEMPLATE_COLS: Record<string, string> = {
  checkin: "sms_checkin_template",
  checkout: "sms_checkout_template",
  reminder: "sms_reminder_template",
  invoice: "sms_invoice_template",
  company_name: "company_name",
}
const TEMPLATE_TOKENS: Record<string, string[]> = {
  checkin: ["{customerName}", "{serviceType}", "{address}", "{companyName}"],
  checkout: ["{customerName}", "{serviceType}", "{address}", "{companyName}"],
  reminder: ["{customerName}", "{serviceType}", "{address}", "{companyName}"],
  invoice: ["{customerName}", "{invoiceNumber}", "{total}", "{payLink}", "{companyName}"],
}

async function getMessageTemplates() {
  const [s] = await sbGet(`app_settings?id=eq.1&select=company_name,sms_checkin_template,sms_checkout_template,sms_reminder_template,sms_invoice_template,notify_on_complete`)
  return {
    company_name: s?.company_name || null,
    templates: {
      checkin: { text: s?.sms_checkin_template || null, tokens: TEMPLATE_TOKENS.checkin, sent: "when a driver checks in (arrival text)" },
      checkout: { text: s?.sms_checkout_template || null, tokens: TEMPLATE_TOKENS.checkout, sent: `on check-out (service complete) — currently ${s?.notify_on_complete ? "ON" : "OFF"}` },
      reminder: { text: s?.sms_reminder_template || null, tokens: TEMPLATE_TOKENS.reminder, sent: "upcoming-service reminders" },
      invoice: { text: s?.sms_invoice_template || null, tokens: TEMPLATE_TOKENS.invoice, sent: "when an invoice is texted (text_invoice)" },
    },
  }
}

async function setMessageTemplate(a: any) {
  const which = String(a.template || "").toLowerCase().trim()
  const col = TEMPLATE_COLS[which]
  if (!col) throw new Error(`Template must be one of: ${Object.keys(TEMPLATE_COLS).join(", ")}.`)
  const text = String(a.text || "").trim()
  if (!text) throw new Error("The new text is required.")
  if (which !== "company_name") {
    // Reject tokens the sender won't fill (they'd go out literally).
    const used = text.match(/\{[a-zA-Z]+\}/g) || []
    const bad = used.filter((t) => !TEMPLATE_TOKENS[which].includes(t))
    if (bad.length) throw new Error(`The ${which} template doesn't support ${bad.join(", ")}. Supported tokens: ${TEMPLATE_TOKENS[which].join(" ")}.`)
  }
  await sbPatch(`app_settings?id=eq.1`, { [col]: text, updated_at: new Date().toISOString() })
  return { ok: true, template: which, text, note: which === "company_name" ? "Company name updated." : "Template saved — future texts use the new wording." }
}

// ---- customer portal: status + 5th-week-free invite -------------------------
const PORTAL_ORIGIN = Deno.env.get("PORTAL_ORIGIN") || "https://valet-waste-crm.vercel.app"

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("")
}
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function getPortalStatus(a: any) {
  const client = await resolveClient(a)
  if (client.error || client.needs_clarification) return client
  const [cust] = await sbGet(
    `customers?id=eq.${enc(client.id)}&select=id,name,email,phone,portal_slug,autopay_consent,autopay_consented_at,run_vault_id,run_card_brand,run_card_last4`,
  )
  if (!cust) return { error: "Client not found." }
  const [sessions, invoices, quotes, requests, credits] = await Promise.all([
    sbGet(`portal_sessions?customer_id=eq.${enc(cust.id)}&select=created_at,last_seen_at&order=created_at.desc&limit=1`),
    sbGet(`invoices?customer_id=eq.${enc(cust.id)}&status=eq.sent&select=number,total,due_date`),
    sbGet(`quotes?customer_id=eq.${enc(cust.id)}&status=in.(sent,draft)&select=number,title,total,status&limit=10`),
    sbGet(`portal_requests?customer_id=eq.${enc(cust.id)}&status=in.(new,seen)&select=kind,message,status,created_at&order=created_at.desc&limit=10`),
    sbGet(`invoice_line_items?description=ilike.${enc("5th pickup week free*")}&select=amount,invoices!inner(customer_id)&invoices.customer_id=eq.${enc(cust.id)}&limit=50`),
  ])
  const balanceDue = round2(invoices.reduce((s: number, i: any) => s + Number(i.total || 0), 0))
  const sess = sessions[0]
  return {
    client: cust.name,
    portal_link: cust.portal_slug ? `${PORTAL_ORIGIN}/?portal=${cust.portal_slug}` : null,
    has_logged_in: !!sess,
    last_seen: sess?.last_seen_at || sess?.created_at || null,
    card_on_file: cust.run_vault_id ? { brand: cust.run_card_brand, last4: cust.run_card_last4 } : null,
    autopay: !!cust.autopay_consent,
    autopay_since: cust.autopay_consented_at || null,
    fifth_week_credits_applied: credits.length,
    balance_due: balanceDue,
    open_invoices: invoices.map((i: any) => ({ number: i.number, total: i.total, due: i.due_date })),
    open_quotes: quotes.map((q: any) => ({ number: q.number, title: q.title, total: q.total, status: q.status })),
    open_requests: requests.map((r: any) => ({ kind: r.kind, message: r.message, status: r.status, date: String(r.created_at).slice(0, 10) })),
    contact: { phone: cust.phone || null, email: cust.email || null },
  }
}

async function invitePortal(a: any) {
  const client = await resolveClient(a)
  if (client.error || client.needs_clarification) return client
  const [cust] = await sbGet(`customers?id=eq.${enc(client.id)}&select=id,name,phone,email,portal_slug`)
  if (!cust) return { error: "Client not found." }
  if (!cust.portal_slug) return { error: `${cust.name} has no portal slug — that shouldn't happen; check the client record.` }

  // One-time login link, 7-day expiry (invites live longer than the 15-min email links).
  const codeRaw = randomToken(24)
  await sbPost("portal_magic_links", {
    customer_id: cust.id,
    code_hash: await sha256(codeRaw),
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  })
  const link = `${PORTAL_ORIGIN}/?portal=${enc(cust.portal_slug)}&code=${codeRaw}`

  const [settings] = await sbGet(`app_settings?id=eq.1&select=company_name`)
  const company = settings?.company_name || "Valet Waste"
  const tpl = a.custom_message
    ? String(a.custom_message)
    : `Hi {customerName}, it's {companyName}! Your customer portal is ready — see invoices, request service, and save a card for easy autopay. Bonus: with a card on file, any month with a 5th pickup week, the 5th week is FREE. Set up here: {link} (your link, good for 7 days)`
  const body = externalName(
    tpl.replace(/\{customerName\}/g, cust.name).replace(/\{companyName\}/g, company).replace(/\{link\}/g, link),
  )

  if (cust.phone) {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to: cust.phone, body, customerId: cust.id, purpose: "manual", sentBy: "Trashy Randy" }),
    })
    const d = await r.json().catch(() => ({}))
    if (!d?.ok) throw new Error(`SMS failed: ${d?.error || `sms function returned ${r.status}`}`)
    return { ok: true, client: cust.name, via: "sms", to: cust.phone, note: "Portal invite texted with the 5th-week-free pitch (login link good for 7 days)." }
  }
  if (cust.email) {
    const key = Deno.env.get("SENDGRID_API_KEY")
    if (!key) return { error: `${cust.name} has no phone and email isn't configured (SENDGRID_API_KEY missing). Add a phone number and retry.` }
    const html = `<p>Hi ${cust.name},</p>
<p>Your ${company} customer portal is ready — see invoices, request service, and save a card for easy autopay.</p>
<p><b>Bonus:</b> with a card on file, any month with a 5th pickup week, the 5th week is <b>FREE</b>.</p>
<p style="margin:14px 0"><a href="${link}" style="display:inline-block;background:#1f7a4d;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">Set up my portal</a></p>
<p style="color:#777;font-size:12px;word-break:break-all">${link}</p>
<p style="color:#777;font-size:13px">This link is yours and works once, within 7 days.</p>`
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: cust.email }] }],
        from: { email: Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com", name: company },
        subject: `Your ${company} portal is ready — 5th pickup week free with autopay`,
        content: [{ type: "text/html", value: html }],
      }),
    })
    if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
    return { ok: true, client: cust.name, via: "email", to: cust.email, note: "No phone on file — portal invite emailed with the 5th-week-free pitch." }
  }
  return { error: `${cust.name} has no phone or email on file — add one with update_client first.` }
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

// ---- read-only lookup tools (billing, pay, proof-of-service, activity, etc.) ----
async function resolveClient(a: any): Promise<any> {
  if (a.customer_id) {
    const c = await sbGet(`customers?id=eq.${enc(a.customer_id)}&select=id,name&limit=1`)
    if (!c[0]) return { error: "No client with that id." }
    return { id: c[0].id, name: c[0].name }
  }
  const q = String(a.client_name || "").trim()
  if (!q) return { error: "Give me a client name or customer_id." }
  const rows = await sbGet(`customers?name=ilike.${enc(`*${q}*`)}&select=id,name&limit=6`)
  if (!rows.length) return { error: `No client matches "${q}".` }
  if (rows.length > 1) return { needs_clarification: true, candidates: rows.map((r: any) => ({ id: r.id, name: r.name })) }
  return { id: rows[0].id, name: rows[0].name }
}

function payPeriodRange(a: any): { start: string; end: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  if (a.start_date && a.end_date) return { start: String(a.start_date).trim(), end: String(a.end_date).trim() }
  const now = new Date()
  const p = a.period || "this_week"
  if (p === "this_month" || p === "last_month") {
    const m = now.getMonth() + (p === "last_month" ? -1 : 0)
    return { start: iso(new Date(now.getFullYear(), m, 1)), end: iso(new Date(now.getFullYear(), m + 1, 0)) }
  }
  const base = new Date(now)
  base.setDate(base.getDate() - base.getDay() + (p === "last_week" ? -7 : 0))
  const end = new Date(base)
  end.setDate(end.getDate() + 6)
  return { start: iso(base), end: iso(end) }
}

async function getClientInvoices(a: any) {
  const c = await resolveClient(a)
  if (c.error || c.needs_clarification) return c
  const includePaid = a.include_paid !== false
  let q = `invoices?customer_id=eq.${enc(c.id)}&select=number,status,total,due_date,paid_at,created_at&order=created_at.desc&limit=50`
  if (!includePaid) q += `&status=neq.paid`
  const rows = await sbGet(q)
  const outstanding = round2(rows.filter((i: any) => i.status !== "paid" && i.status !== "draft").reduce((s: number, i: any) => s + Number(i.total || 0), 0))
  return {
    client: c.name,
    outstanding_balance: outstanding,
    count: rows.length,
    invoices: rows.map((i: any) => ({ number: i.number, status: i.status, total: Number(i.total || 0), due: i.due_date, paid_at: i.paid_at, created: i.created_at })),
  }
}

async function getTechPay(a: any) {
  const { start, end } = payPeriodRange(a)
  let onlyDriverId: string | null = null
  if (a.employee) {
    const like = enc(`*${String(a.employee).trim()}*`)
    const profs = await sbGet(`profiles?or=(full_name.ilike.${like},email.ilike.${like})&select=id,full_name,email&limit=5`)
    if (!profs.length) return { error: `No employee matches "${a.employee}".` }
    if (profs.length > 1) return { needs_clarification: true, matches: profs.map((p: any) => p.full_name || p.email), note: "Which employee?" }
    onlyDriverId = profs[0].id
  }
  let sq = `route_stops?select=tech_pay,check_in,check_out,pay_override,properties(tech_pay),routes!inner(driver_id,service_date),stop_photos(id)&routes.service_date=gte.${enc(start)}&routes.service_date=lte.${enc(end)}&limit=3000`
  if (onlyDriverId) sq += `&routes.driver_id=eq.${enc(onlyDriverId)}`
  const stops = await sbGet(sq)
  const byDriver: Record<string, { payable: number; pending: number; jobs: number }> = {}
  for (const s of stops) {
    const drv = s.routes?.driver_id
    if (!drv) continue
    const pay = Number(s.tech_pay ?? s.properties?.tech_pay ?? 0)
    const complete = !!(s.check_in && s.check_out && (s.stop_photos || []).length > 0)
    const d = (byDriver[drv] ||= { payable: 0, pending: 0, jobs: 0 })
    d.jobs++
    if (complete || s.pay_override) d.payable += pay
    else d.pending += pay
  }
  const ids = Object.keys(byDriver)
  const names: Record<string, string> = {}
  if (ids.length) for (const p of await sbGet(`profiles?id=in.(${ids.join(",")})&select=id,full_name,email`)) names[p.id] = p.full_name || p.email
  const hoursById: Record<string, number> = {}
  if (ids.length) {
    const ts = await sbGet(`timesheets?profile_id=in.(${ids.join(",")})&work_date=gte.${enc(start)}&work_date=lte.${enc(end)}&select=profile_id,clock_in,clock_out`)
    for (const t of ts) {
      if (!t.clock_in || !t.clock_out) continue
      const h = (new Date(t.clock_out).getTime() - new Date(t.clock_in).getTime()) / 3600000
      if (h > 0) hoursById[t.profile_id] = (hoursById[t.profile_id] || 0) + h
    }
  }
  const people = ids.map((id) => ({
    employee: names[id] || "(unknown)",
    payable: round2(byDriver[id].payable),
    pending: round2(byDriver[id].pending),
    jobs: byDriver[id].jobs,
    hours: hoursById[id] ? Math.round(hoursById[id] * 10) / 10 : 0,
  })).sort((x, y) => y.payable - x.payable)
  return { period: { start, end }, count: people.length, pay: people, note: "Payable = jobs with check-in + check-out + photo (or an approved override). Pending = not complete yet." }
}

async function getServiceHistory(a: any) {
  const limit = Number(a.limit) > 0 ? Math.min(Math.floor(Number(a.limit)), 100) : 20
  let propFilter = ""
  let label = ""
  if (a.address) {
    const like = enc(`*${String(a.address).trim()}*`)
    const props = await sbGet(`properties?or=(address.ilike.${like},name.ilike.${like})&select=id&limit=50`)
    if (!props.length) return { count: 0, visits: [], note: `No property matches "${a.address}".` }
    propFilter = `&property_id=in.(${props.map((p: any) => p.id).join(",")})`
    label = String(a.address)
  } else if (a.client_name) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${String(a.client_name).trim()}*`)}&select=id&limit=10`)
    if (!custs.length) return { count: 0, visits: [], note: `No client matches "${a.client_name}".` }
    const props = await sbGet(`properties?customer_id=in.(${custs.map((c: any) => c.id).join(",")})&select=id&limit=500`)
    if (!props.length) return { count: 0, visits: [] }
    propFilter = `&property_id=in.(${props.map((p: any) => p.id).join(",")})`
    label = String(a.client_name)
  } else {
    return { error: "Give me an address or a client name." }
  }
  const stops = await sbGet(`route_stops?select=check_in,check_out,on_my_way_at,status,check_in_lat,check_in_lng,properties(address,name),routes(service_date,code),stop_photos(id)${propFilter}&order=check_in.desc.nullslast&limit=${limit}`)
  return {
    of: label,
    count: stops.length,
    visits: stops.map((s: any) => ({
      date: s.routes?.service_date,
      address: s.properties?.address || s.properties?.name,
      on_my_way: s.on_my_way_at,
      checked_in: s.check_in,
      checked_out: s.check_out,
      photos: (s.stop_photos || []).length,
      gps: s.check_in_lat != null ? `${s.check_in_lat},${s.check_in_lng}` : null,
      status: s.check_out ? "completed" : s.check_in ? "in progress" : "not serviced",
    })),
  }
}

async function listActivity(a: any) {
  const limit = Number(a.limit) > 0 ? Math.min(Math.floor(Number(a.limit)), 100) : 30
  let q = `activity_log?select=created_at,actor,type,summary&order=created_at.desc&limit=${limit}`
  if (a.type) q += `&type=eq.${enc(String(a.type).trim())}`
  const rows = await sbGet(q)
  return { count: rows.length, activity: rows }
}

async function listMessages(a: any) {
  const limit = Number(a.limit) > 0 ? Math.min(Math.floor(Number(a.limit)), 100) : 25
  let filter = ""
  if (a.client_name) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${String(a.client_name).trim()}*`)}&select=id&limit=5`)
    if (!custs.length) return { count: 0, messages: [], note: `No client matches "${a.client_name}".` }
    filter = `&customer_id=in.(${custs.map((c: any) => c.id).join(",")})`
  } else if (a.phone) {
    const digits = String(a.phone).replace(/\D/g, "")
    if (digits) filter = `&or=(to_number.ilike.*${digits}*,from_number.ilike.*${digits}*)`
  }
  const rows = await sbGet(`sms_messages?select=created_at,direction,to_number,from_number,body,status,purpose${filter}&order=created_at.desc&limit=${limit}`)
  return { count: rows.length, messages: rows.map((m: any) => ({ at: m.created_at, dir: m.direction, to: m.to_number, from: m.from_number, body: m.body, status: m.status, purpose: m.purpose })) }
}

async function listTeam(a: any) {
  let q = `profiles?select=full_name,email,role,is_driver,phone,business_lines&order=full_name.asc&limit=200`
  if (a.drivers_only) q += `&is_driver=eq.true`
  const rows = await sbGet(q)
  return { count: rows.length, team: rows.map((p: any) => ({ name: p.full_name, email: p.email, role: p.role, driver: !!p.is_driver, phone: p.phone, lines: p.business_lines || [] })) }
}

async function listQuotes(a: any) {
  const limit = Number(a.limit) > 0 ? Math.min(Math.floor(Number(a.limit)), 100) : 25
  let filter = ""
  if (a.client_name) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${String(a.client_name).trim()}*`)}&select=id&limit=5`)
    if (!custs.length) return { count: 0, quotes: [], note: `No client matches "${a.client_name}".` }
    filter += `&customer_id=in.(${custs.map((c: any) => c.id).join(",")})`
  }
  if (a.status) filter += `&status=eq.${enc(String(a.status).trim())}`
  const rows = await sbGet(`quotes?select=number,title,total,status,created_at,customer_id${filter}&order=created_at.desc&limit=${limit}`)
  const ids = [...new Set(rows.map((r: any) => r.customer_id).filter(Boolean))]
  const names: Record<string, string> = {}
  if (ids.length) for (const c of await sbGet(`customers?id=in.(${ids.join(",")})&select=id,name`)) names[c.id] = c.name
  return { count: rows.length, quotes: rows.map((r: any) => ({ number: r.number, title: r.title, total: Number(r.total || 0), status: r.status, created: r.created_at, client: r.customer_id ? (names[r.customer_id] || null) : null })) }
}

async function listServiceRequests(a: any) {
  const limit = Number(a.limit) > 0 ? Math.min(Math.floor(Number(a.limit)), 100) : 25
  let q = `portal_requests?select=kind,message,status,created_at,customer_id,property_ids&order=created_at.desc&limit=${limit}`
  if (a.status) q += `&status=eq.${enc(String(a.status).trim())}`
  const rows = await sbGet(q)
  const ids = [...new Set(rows.map((r: any) => r.customer_id).filter(Boolean))]
  const names: Record<string, string> = {}
  if (ids.length) for (const c of await sbGet(`customers?id=in.(${ids.join(",")})&select=id,name`)) names[c.id] = c.name
  return { count: rows.length, requests: rows.map((r: any) => ({ kind: r.kind, message: r.message, status: r.status, created: r.created_at, client: r.customer_id ? (names[r.customer_id] || null) : null, properties: (r.property_ids || []).length })) }
}

// ---- field ops (Check My Location workflow) --------------------------------
async function sbDel(path: string) {
  const r = await fetch(`${REST}/${path}`, { method: "DELETE", headers: HEADERS })
  if (!r.ok) throw new Error(`DELETE ${path}: ${r.status} ${await r.text()}`)
}

// JS port of the DB's norm_address(): a case/punctuation/suffix-insensitive key
// so the same address entered under two clients collapses to one match.
const ADDR_ABBR: Record<string, string> = {
  street: "st", saint: "st", avenue: "ave", drive: "dr", road: "rd", boulevard: "blvd",
  lane: "ln", court: "ct", circle: "cir", highway: "hwy", place: "pl", terrace: "ter",
  parkway: "pkwy", north: "n", south: "s", east: "e", west: "w", apartment: "apt",
}
function normAddress(a: string | null | undefined): string {
  return String(a ?? "")
    .toLowerCase()
    .replace(/\b(united states of america|united states|usa|us)\b/g, " ")
    .replace(/[.,#]/g, " ")
    .replace(/[a-z]+/g, (w) => ADDR_ABBR[w] ?? w)
    .replace(/\s+/g, " ")
    .trim()
}

async function findNearbyProperties(a: any) {
  const lat = Number(a.lat), lng = Number(a.lng)
  if (!isFinite(lat) || !isFinite(lng)) throw new Error("lat and lng are required.")
  const limit = Math.min(Number(a.limit ?? 5) || 5, 10)
  const date = a.date ? String(a.date) : today()
  const props = await sbGet(`properties?select=id,name,address,service,price,paused,pickup_days,lat,lng,customer_id,created_at,customers(name)&lat=not.is.null&lng=not.is.null`)
  const ranked = (props as any[])
    .map((p: any) => ({ ...p, miles: milesBetween(lat, lng, p.lat, p.lng) }))
    .sort((x: any, y: any) => x.miles - y.miles)

  // Group by normalized address FIRST: the same address under two clients is a
  // known data-entry duplicate, not two candidate stops. The driver never picks.
  const groups: { key: string; copies: any[] }[] = []
  const byKey: Record<string, { key: string; copies: any[] }> = {}
  for (const p of ranked) {
    const key = normAddress(p.address || p.name) || `id:${p.id}`
    if (byKey[key]) { byKey[key].copies.push(p); continue }
    const g = { key, copies: [p] }
    byKey[key] = g
    groups.push(g)
  }
  const chosen = groups.slice(0, limit)

  const routes = await sbGet(`routes?service_date=eq.${enc(date)}&select=id,code`)
  let stopsToday: any[] = []
  if (routes.length) {
    stopsToday = await sbGet(`route_stops?route_id=in.(${routes.map((r: any) => enc(r.id)).join(",")})&select=id,property_id,route_id,status,check_in`)
  }
  const byProp: Record<string, any> = {}
  for (const s of stopsToday) byProp[s.property_id] = s
  const onRoute = (p: any) =>
    byProp[p.id]
      ? {
          stop_id: byProp[p.id].id,
          route_code: routes.find((r: any) => r.id === byProp[p.id].route_id)?.code ?? null,
          status: byProp[p.id].status,
          checked_in: !!byProp[p.id].check_in,
        }
      : null

  // Which copy of a duplicated address to work: the one already on today's route
  // (checked in beats pending), then unpaused, then scheduled for today, then priced,
  // then the oldest record. Deterministic so repeat lookups land on the same copy.
  const weekday = DAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]
  const score = (p: any) => {
    const st = byProp[p.id]
    return (st ? (st.check_in ? 16 : 8) : 0) +
      (p.paused ? 0 : 4) +
      ((p.pickup_days || []).includes(weekday) ? 2 : 0) +
      (p.price != null ? 1 : 0)
  }
  const shape = (p: any) => ({
    property_id: p.id,
    address: p.address || p.name,
    client: p.customers?.name ?? null,
    customer_id: p.customer_id ?? null,
    service: p.service ?? null,
    price: p.price ?? null,
    paused: !!p.paused,
    pickup_days: p.pickup_days ?? [],
    distance_feet: Math.round(p.miles * 5280),
    distance_miles: Math.round(p.miles * 100) / 100,
    on_route_today: onRoute(p),
  })

  let dupes = 0
  const matches = chosen.map((g) => {
    const sorted = [...g.copies].sort(
      (x, y) => score(y) - score(x) || String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")),
    )
    const [primary, ...others] = sorted
    if (others.length) dupes++
    return {
      ...shape(primary),
      ...(others.length
        ? {
            same_address_on_file: sorted.length,
            other_copies: others.map(shape),
            duplicate_note:
              "Known data-entry duplicate — the same address under more than one client. Use this copy, do NOT ask the driver which client, and mention once that it needs an end-of-day Edit & Merge on the Clients tab.",
          }
        : {}),
    }
  })

  return {
    date,
    matches,
    ...(dupes
      ? {
          duplicates_collapsed: dupes,
          note: "Some matches are the same address entered under more than one client (expected — two people set the CRM up). They were collapsed to one match each. Work the primary copy, never make the driver choose, and remind them once to review duplicates on the Clients tab at the end of the day.",
        }
      : {}),
  }
}

// Find one stop by id, or by address on a date's routes.
async function resolveStop(a: any): Promise<any> {
  if (a.stop_id) {
    const s = await sbGet(`route_stops?id=eq.${enc(a.stop_id)}&select=id,route_id,seq,status,check_in,check_out,property_id,properties(address,name),routes(code,service_date)`)
    if (!s.length) throw new Error("No stop with that id.")
    return s[0]
  }
  const date = a.date ? String(a.date) : today()
  // "Stop 57" — the visit NUMBER shown in route lists (seq), not a UUID.
  if (a.stop_number != null) {
    const n = Number(a.stop_number)
    if (!Number.isInteger(n) || n < 1) throw new Error("stop_number must be a positive whole number.")
    let rq = `routes?service_date=eq.${enc(date)}&select=id,code,service_date`
    if (a.route_code) rq += `&code=eq.${enc(String(a.route_code).trim().toUpperCase())}`
    const routes = await sbGet(rq)
    if (!routes.length) throw new Error(`No routes on ${date}.`)
    const stops = await sbGet(
      `route_stops?route_id=in.(${routes.map((r: any) => enc(r.id)).join(",")})&select=id,route_id,seq,status,check_in,check_out,property_id,properties(address,name)&order=seq.asc`,
    )
    const bySeq = stops.filter((x: any) => x.seq === n)
    let s = bySeq.length === 1 ? bySeq[0] : undefined
    if (!s && bySeq.length > 1) {
      return { needs_clarification: true, which: "stop", matches: bySeq.map((x: any) => ({ stop_id: x.id, address: x.properties?.address, route: (routes.find((r: any) => r.id === x.route_id) || {}).code })) }
    }
    if (!s) s = stops[n - 1] // no exact seq — fall back to nth stop in order
    if (!s) throw new Error(`Stop #${n} doesn't exist on ${date} — there ${stops.length === 1 ? "is 1 stop" : `are ${stops.length} stops`}.`)
    s.routes = routes.find((r: any) => r.id === s.route_id)
    return s
  }
  const addr = String(a.address ?? "").trim()
  if (!addr) throw new Error("Give a stop_id or an address.")
  const routes = await sbGet(`routes?service_date=eq.${enc(date)}&select=id,code,service_date`)
  if (!routes.length) throw new Error(`No routes on ${date}.`)
  const stops = await sbGet(
    `route_stops?route_id=in.(${routes.map((r: any) => enc(r.id)).join(",")})&select=id,route_id,seq,status,check_in,check_out,property_id,properties!inner(address,name)&properties.address=ilike.${enc(`*${addr}*`)}`,
  )
  if (!stops.length) throw new Error(`No stop matching "${addr}" on ${date}.`)
  if (stops.length > 1) {
    // Several stops at the SAME address = a known duplicate record, not a real
    // ambiguity. Take one (prefer a not-yet-checked-in copy) instead of asking.
    const keys = new Set(stops.map((s: any) => normAddress(s.properties?.address || s.properties?.name)))
    if (keys.size > 1) {
      return { needs_clarification: true, which: "stop", matches: stops.map((s: any) => ({ stop_id: s.id, address: s.properties?.address })) }
    }
    const pick = stops.find((s: any) => !s.check_in) ?? stops[0]
    pick.routes = routes.find((r: any) => r.id === pick.route_id)
    pick.duplicate_address_copies = stops.length
    pick.duplicate_note = "That address is on file more than once; used one copy. Mention an end-of-day Edit & Merge on the Clients tab, don't ask which client."
    return pick
  }
  const s = stops[0]
  s.routes = routes.find((r: any) => r.id === s.route_id)
  return s
}

async function setStopStatus(a: any) {
  const s = await resolveStop(a)
  if (s.needs_clarification) return s
  const st = String(a.status ?? "").trim()
  const now = new Date().toISOString()
  let patch: any
  if (st === "on_my_way") patch = { on_my_way_at: now }
  else if (st === "check_in") patch = { status: "enroute", check_in: now }
  else if (st === "check_out") patch = { status: "done", check_in: s.check_in ?? now, check_out: now }
  else if (st === "reset") patch = { status: "pending", check_in: null, check_out: null, on_my_way_at: null }
  else throw new Error("status must be on_my_way, check_in, check_out, or reset.")
  const before = await snapshotStop(s.id)
  await sbPatch(`route_stops?id=eq.${enc(s.id)}`, patch)
  await logUndo("stop_status", s.id, before, patch)
  return { ok: true, stop_id: s.id, address: s.properties?.address || s.properties?.name, route: s.routes?.code ?? null, date: s.routes?.service_date ?? null, set: st }
}

async function moveStopTool(a: any) {
  const s = await resolveStop(a)
  if (s.needs_clarification) return s
  const stops = await sbGet(`route_stops?route_id=eq.${enc(s.route_id)}&select=id,seq&order=seq.asc`)
  const idx = stops.findIndex((x: any) => x.id === s.id)
  let to: number
  if (a.position != null) to = Math.max(0, Math.min(stops.length - 1, Number(a.position) - 1))
  else if (a.direction === "up") to = Math.max(0, idx - 1)
  else if (a.direction === "down") to = Math.min(stops.length - 1, idx + 1)
  else throw new Error("Give direction 'up'/'down' or a position number.")
  const [row] = stops.splice(idx, 1)
  stops.splice(to, 0, row)
  const before = await snapshotStop(s.id)
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].seq !== i + 1) await sbPatch(`route_stops?id=eq.${enc(stops[i].id)}`, { seq: i + 1 })
  }
  await logUndo("stop_moved", s.id, before)
  return { ok: true, address: s.properties?.address || s.properties?.name, new_position: to + 1, of: stops.length }
}

async function removeStopTool(a: any) {
  const s = await resolveStop(a)
  if (s.needs_clarification) return s
  // Full row snapshot — undo re-inserts it with the same id (photos survive).
  const full = (await sbGet(`route_stops?id=eq.${enc(s.id)}&select=*`))[0]
  await sbDel(`route_stops?id=eq.${enc(s.id)}`)
  await logUndo("stop_removed", s.id, full)
  return { ok: true, removed: s.properties?.address || s.properties?.name, route: s.routes?.code ?? null, date: s.routes?.service_date ?? null, note: "Off the route — the address itself is kept. Say 'undo that' to put it right back." }
}

async function addInvoiceLine(a: any) {
  let customerId: string | null = a.customer_id ?? null
  if (!customerId && a.client_name) {
    const custs = await sbGet(`customers?name=ilike.${enc(`*${a.client_name}*`)}&select=id,name&limit=5`)
    if (custs.length === 1) customerId = custs[0].id
    else if (!custs.length) throw new Error(`No client matching "${a.client_name}".`)
    else return { needs_clarification: true, which: "client", matches: custs.map((c: any) => ({ id: c.id, name: c.name })) }
  }
  if (!customerId) throw new Error("Give customer_id or client_name.")
  const amount = Math.round(Number(a.amount) * 100) / 100
  if (!isFinite(amount) || amount <= 0) throw new Error("A positive amount is required.")
  const d = today()
  const monthStart = d.slice(0, 8) + "01"
  let inv = (await sbGet(`invoices?customer_id=eq.${enc(customerId)}&status=eq.draft&issue_date=gte.${enc(monthStart)}&select=id,number,discount&order=created_at.desc&limit=1`))[0]
  if (!inv) {
    inv = (await sbPost("invoices", { customer_id: customerId, status: "draft", issue_date: d, subtotal: 0, total: 0, discount: 0 }))[0]
  }
  const lines = await sbGet(`invoice_line_items?invoice_id=eq.${enc(inv.id)}&select=id,amount,position`)
  await sbPost("invoice_line_items", {
    invoice_id: inv.id,
    description: String(a.description ?? "Service"),
    quantity: 1,
    unit_price: amount,
    amount,
    position: lines.length,
  })
  const subtotal = Math.round((lines.reduce((t: number, l: any) => t + Number(l.amount || 0), 0) + amount) * 100) / 100
  const total = Math.max(0, Math.round((subtotal - Number(inv.discount || 0)) * 100) / 100)
  await sbPatch(`invoices?id=eq.${enc(inv.id)}`, { subtotal, total })
  return { ok: true, invoice: inv.number ?? null, line: a.description, amount, new_total: total, note: "On this month's draft — goes out at month end." }
}

async function cleanupUnconfirmed(a: any) {
  const date = a.date ? String(a.date) : today()
  const wantCode = a.route_code ? String(a.route_code).trim().toUpperCase() : null
  const routes = (await sbGet(`routes?service_date=eq.${enc(date)}&select=id,code`)).filter((r: any) => !wantCode || r.code === wantCode)
  if (!routes.length) throw new Error(`No routes on ${date}${wantCode ? ` with code ${wantCode}` : ""}.`)
  const stops = await sbGet(`route_stops?route_id=in.(${routes.map((r: any) => enc(r.id)).join(",")})&select=id,route_id,check_in,status,property_id,properties(address,name)`)
  const unconfirmed = (stops as any[]).filter((s: any) => !s.check_in && s.status !== "done" && s.status !== "skipped")
  const list = unconfirmed.map((s: any) => ({
    stop_id: s.id,
    address: s.properties?.address || s.properties?.name,
    route: routes.find((r: any) => r.id === s.route_id)?.code ?? null,
  }))
  if (!a.confirm) {
    return { date, count: list.length, unconfirmed: list, note: "PREVIEW ONLY — nothing changed. Read this list back and get an explicit YES, then call again with confirm=true." }
  }
  let removed = 0
  const pausedIds = new Set<string>()
  for (const s of unconfirmed) {
    const full = (await sbGet(`route_stops?id=eq.${enc(s.id)}&select=*`))[0]
    await sbDel(`route_stops?id=eq.${enc(s.id)}`)
    await logUndo("stop_removed", s.id, full)
    removed++
    if (s.property_id && !pausedIds.has(s.property_id)) {
      await sbPatch(`properties?id=eq.${enc(s.property_id)}`, { paused: true })
      pausedIds.add(s.property_id)
    }
  }
  return { ok: true, date, removed, paused: pausedIds.size, note: "Removed from the route and PAUSED (recoverable on the Clients screen — nothing deleted)." }
}

async function optimizeRouteTool(a: any) {
  const code = String(a.route_code ?? "").trim().toUpperCase()
  const date = a.date ? String(a.date) : today()
  if (!code) throw new Error("route_code is required.")
  const route = (await sbGet(`routes?code=eq.${enc(code)}&service_date=eq.${enc(date)}&select=id,code`))[0]
  if (!route) throw new Error(`No Route ${code} on ${date}.`)
  const stops = await sbGet(`route_stops?route_id=eq.${enc(route.id)}&select=id,seq,lat,lng,check_in,status,property_id,properties(address,name,lat,lng)&order=seq.asc`)
  const locate = (s: any) => ({ lat: s.properties?.lat ?? s.lat, lng: s.properties?.lng ?? s.lng })
  const settings = await sbGet(`app_settings?id=eq.1&select=depot_lat,depot_lng`)
  let curLat: number | null = settings[0]?.depot_lat ?? null
  let curLng: number | null = settings[0]?.depot_lng ?? null
  const fixed = (stops as any[]).filter((s: any) => s.check_in || s.status === "done")
  const todo = (stops as any[]).filter((s: any) => !s.check_in && s.status !== "done")
  const located = todo.filter((s: any) => { const l = locate(s); return l.lat != null && l.lng != null })
  const unlocated = todo.filter((s: any) => { const l = locate(s); return l.lat == null || l.lng == null })
  if (fixed.length) { const l = locate(fixed[fixed.length - 1]); if (l.lat != null) { curLat = l.lat; curLng = l.lng } }
  if ((curLat == null || curLng == null) && located.length) { const l = locate(located[0]); curLat = l.lat; curLng = l.lng }
  const ordered: any[] = []
  const pool = [...located]
  while (pool.length && curLat != null && curLng != null) {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < pool.length; i++) {
      const l = locate(pool[i])
      const dmi = milesBetween(curLat, curLng, l.lat, l.lng)
      if (dmi < bd) { bd = dmi; bi = i }
    }
    const [nxt] = pool.splice(bi, 1)
    ordered.push(nxt)
    const l = locate(nxt)
    curLat = l.lat
    curLng = l.lng
  }
  const finalOrder = [...fixed, ...ordered, ...pool, ...unlocated]
  const before = (stops as any[]).map((s: any) => ({ stop_id: s.id, seq: s.seq }))
  for (let i = 0; i < finalOrder.length; i++) {
    if (finalOrder[i].seq !== i + 1) await sbPatch(`route_stops?id=eq.${enc(finalOrder[i].id)}`, { seq: i + 1 })
  }
  await logUndo("route_optimized", null, before)
  return {
    ok: true,
    route: code,
    date,
    reordered: ordered.length,
    kept_in_place: fixed.length,
    missing_coords: unlocated.length,
    order: finalOrder.map((s: any, i: number) => `${i + 1}. ${s.properties?.address || s.properties?.name}`),
  }
}

async function runTool(name: string, input: any): Promise<unknown> {
  switch (name) {
    case "find_clients": return await findClients(input)
    case "list_properties": return await listProperties(input)
    case "list_needs_review": return await listNeedsReview(input)
    case "edit_property": return await editProperty(input)
    case "flag_properties": return await flagProperties(input)
    case "pause_properties": return await pauseProperties(input)
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
    case "skip_stop": return await skipStopTool(input)
    case "move_pickup_once": return await movePickupOnce(input)
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
    case "merge_service": return await mergeService(input)
    case "get_client_invoices": return await getClientInvoices(input)
    case "get_tech_pay": return await getTechPay(input)
    case "get_service_history": return await getServiceHistory(input)
    case "list_activity": return await listActivity(input)
    case "list_messages": return await listMessages(input)
    case "list_team": return await listTeam(input)
    case "list_quotes": return await listQuotes(input)
    case "list_service_requests": return await listServiceRequests(input)
    case "find_nearby_properties": return await findNearbyProperties(input)
    case "set_stop_status": return await setStopStatus(input)
    case "move_stop": return await moveStopTool(input)
    case "remove_stop": return await removeStopTool(input)
    case "add_invoice_line": return await addInvoiceLine(input)
    case "cleanup_unconfirmed_stops": return await cleanupUnconfirmed(input)
    case "optimize_route": return await optimizeRouteTool(input)
    case "undo_last_action": return await undoLastActionTool()
    case "add_property": return await addProperty(input)
    case "untag_client": return await untagClient(input)
    case "list_tags": return await listTagsTool()
    case "edit_tag": return await editTag(input)
    case "add_client_note": return await addClientNote(input)
    case "list_client_notes": return await listClientNotes(input)
    case "set_randy_tone": return await setRandyTone(input)
    case "set_depot": return await setDepot(input)
    case "get_message_templates": return await getMessageTemplates()
    case "set_message_template": return await setMessageTemplate(input)
    case "get_portal_status": return await getPortalStatus(input)
    case "invite_portal": return await invitePortal(input)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

// Prompt caching: one ephemeral breakpoint on the LAST tool caches the entire
// stable prefix — system prompt + all ~66 tool definitions (~17K tokens) — so
// repeat calls within the TTL read it at ~10% of list price instead of
// re-billing the whole block on every request and every agent-loop iteration.
// The prefix must stay BYTE-IDENTICAL between requests: volatile context
// (pins / pending actions / SMS mode) is injected into the last user message
// in the handler, never into `system`.
const CACHED_TOOLS = tools.map((t: any, i: number) =>
  i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
)

async function callAnthropic(messages: unknown[], apiKey: string, system: string) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools: CACHED_TOOLS, messages }),
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
    let callerLabel = "unknown"
    if (!isSystemCaller) {
      const ures = token
        ? await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
        : null
      if (!ures || !ures.ok) return json({ text: "Please sign in to use Trashy Randy.", actions: [] }, 401)
      const callerId = (await ures.json())?.id
      const prof = callerId ? await sbGet(`profiles?id=eq.${enc(callerId)}&select=role,full_name,email`) : []
      if (!["admin", "staff"].includes(prof?.[0]?.role)) {
        return json({ text: "Trashy Randy is only available to staff accounts.", actions: [] }, 403)
      }
      callerLabel = prof?.[0]?.full_name || prof?.[0]?.email || "staff"
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
    if (!apiKey) {
      return json({
        text: "I'm not connected yet — the ANTHROPIC_API_KEY secret hasn't been set in Supabase. Once it's added I can start helping.",
        actions: [],
      })
    }

    const { messages: incoming, sms, pins: incomingPins, pending_action } = await req.json()
    const messages: any[] = (incoming || [])
      .filter((m: any) => m && m.text)
      .map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }))

    // Personality is configured in Settings (app_settings.randy_tone).
    let tone: string | null = null
    try { tone = (await sbGet(`app_settings?id=eq.1&select=randy_tone`))?.[0]?.randy_tone ?? null } catch (_) { /* fall back to default */ }
    let system = buildSystem(tone)
    // Anchor the model to the real current date (business timezone — the edge
    // runtime is UTC, which would roll over a day early every ET evening).
    // Without this, "Aug 24" gets resolved against the model's training-era
    // year and every future-dated lookup comes back empty.
    const nowEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", dateStyle: "short" }).format(new Date())
    const dowEt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(new Date())
    system += `\n\nCURRENT DATE: ${nowEt} (a ${dowEt}). Resolve EVERY date the user gives you — including month + day like "Aug 24" or "March 3", and relatives like "today", "tomorrow", "next Monday" — against THIS date and year, then pass tools the exact YYYY-MM-DD. Never assume a different year.`

    // Volatile context rides on the LAST USER MESSAGE, not the system prompt —
    // the system+tools block must stay byte-identical across requests or the
    // prompt cache (CACHED_TOOLS) never hits. The last user message changes
    // every turn anyway, so this prefix costs nothing extra to cache.
    let volatileCtx = ""
    // Pinned context + pending risky action echo back from the client (they
    // die with the request otherwise — the #1 cause of "found it, then lost it").
    if (Array.isArray(incomingPins) && incomingPins.length) {
      volatileCtx += `\n\nPINNED CONTEXT (resolved in recent turns — still current unless the conversation clearly moved on): ${JSON.stringify(incomingPins).slice(0, 1500)}\n"it", "that one", "that stop", "there", "do it" refer to a pinned record — pass its stop_id/property_id directly; do NOT search again.`
    }
    if (pending_action && pending_action.tool) {
      volatileCtx += `\n\nPENDING ACTION awaiting the user's yes/no: ${JSON.stringify(pending_action).slice(0, 1200)}\nIf they confirm (yes / do it / go ahead / yeah), call ${pending_action.tool} with EXACTLY this input — never re-resolve or re-search. If they decline or ask for something else, drop it silently and don't re-offer.`
    }
    if (isSystemCaller && sms?.staff_name) {
      callerLabel = `sms: ${sms.staff_name}`
      volatileCtx += `\n\nSMS MODE: You are replying by TEXT MESSAGE to ${sms.staff_name}, a staff member texting the company's business number from their phone. Rules: reply in plain conversational text only (no markdown, no bullet lists, no headers); keep it under 450 characters; keep the language clean and professional regardless of your tone setting — this is a real SMS from the business number. Your reply text is automatically delivered back to them as a text, so do NOT use the send_sms tool to answer them; only use send_sms if they ask you to text someone ELSE.`
    }
    if (volatileCtx && messages.length && messages[messages.length - 1].role === "user") {
      const last = messages[messages.length - 1]
      messages[messages.length - 1] = { role: "user", content: volatileCtx.trim() + "\n\n" + last.content }
    }

    const actions: Array<{ tool: string; result: unknown }> = []
    const newPins: unknown[] = []
    let pendingOut: { tool: string; input: any } | null = null
    let finalText = ""
    // Per-request token accounting (0053) — Anthropic's usage fields are
    // mutually exclusive: input/output exclude cache read/write.
    const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    let iterCount = 0
    const turnsIn = messages.length

    for (let i = 0; i < 8; i++) {
      const res = await callAnthropic(messages, apiKey, system)
      iterCount++
      const u: any = res.usage || {}
      usage.input += Number(u.input_tokens || 0)
      usage.output += Number(u.output_tokens || 0)
      usage.cacheWrite += Number(u.cache_creation_input_tokens || 0)
      usage.cacheRead += Number(u.cache_read_input_tokens || 0)
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
        // Pin/propose are control-plane calls: collect them for the response
        // instead of running anything.
        if (block.name === "pin_stop" || block.name === "pin_property") {
          newPins.push({ ...(block.input || {}) })
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ ok: true }) })
          continue
        }
        if (block.name === "propose_action") {
          pendingOut = { tool: String(block.input?.tool || ""), input: block.input?.input || {} }
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ ok: true, proposed: true }) })
          continue
        }
        try {
          const out = await runTool(block.name, block.input)
          if (block.name !== "find_clients" && block.name !== "get_overview" && block.name !== "list_routes" && block.name !== "list_needs_review" && block.name !== "find_duplicates" && block.name !== "list_skipped_stops" && block.name !== "list_route_stops" && block.name !== "list_services" && block.name !== "list_automations" && block.name !== "list_jobs" && block.name !== "get_client_invoices" && block.name !== "get_tech_pay" && block.name !== "get_service_history" && block.name !== "list_activity" && block.name !== "list_messages" && block.name !== "list_team" && block.name !== "list_quotes" && block.name !== "list_service_requests") {
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

    // Best-effort telemetry (0053): who talked to Randy, how big the request
    // was, and whether the prompt cache hit. Never blocks the reply.
    try {
      await sbPost("ai_usage", {
        caller: callerLabel,
        sms: isSystemCaller,
        turns: turnsIn,
        iterations: iterCount,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_write_tokens: usage.cacheWrite,
        cache_read_tokens: usage.cacheRead,
      })
    } catch (_) { /* telemetry is non-critical */ }

    return json({ text: finalText || "Done.", actions, pins: newPins, pending_action: pendingOut })
  } catch (e) {
    return json({ text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, actions: [] }, 200)
  }
})
