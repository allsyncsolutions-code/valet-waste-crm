// Automation runner — executes enabled rows from the `automations` table.
//
// Called by pg_cron each morning (service key bearer) or by the Automations
// tab's "Run now" (staff user token). Currently implements:
//   • outstanding_digest — texts staff a summary of unpaid invoices with days
//     overdue and last-contact date; staff reply to Trashy Randy to act.
//
// Deploy with JWT verification OFF (custom auth below):
//   supabase functions deploy automations-run --no-verify-jwt

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

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders })
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}
async function sbPatch(path: string, body: unknown) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
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

const fmtMoney = (v: number) => `$${Number(v || 0).toFixed(2)}`
const fmtDay = (ts: string | null) => {
  if (!ts) return "never"
  try { return new Date(ts).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) } catch { return "?" }
}

// ---- outstanding_digest -----------------------------------------------------
async function runOutstandingDigest(): Promise<string> {
  const today = new Date()
  const invoices = await sbGet(
    `invoices?status=eq.sent&select=id,number,total,due_date,sent_at,customer_id&order=due_date.asc.nullslast&limit=50`,
  )
  if (!invoices.length) return "No outstanding invoices — no digest sent."

  const custIds = [...new Set(invoices.map((i: any) => i.customer_id).filter(Boolean))]
  const customers: Record<string, string> = {}
  if (custIds.length) {
    for (const c of await sbGet(`customers?id=in.(${custIds.join(",")})&select=id,name`)) customers[c.id] = c.name
  }

  // Last outbound contact per customer (invoice/reminder/manual texts).
  const lastContact: Record<string, string> = {}
  if (custIds.length) {
    const msgs = await sbGet(
      `sms_messages?direction=eq.out&customer_id=in.(${custIds.join(",")})&purpose=in.(invoice,reminder,manual)&select=customer_id,created_at&order=created_at.desc&limit=200`,
    )
    for (const m of msgs) if (m.customer_id && !lastContact[m.customer_id]) lastContact[m.customer_id] = m.created_at
  }

  const lines = invoices.slice(0, 10).map((inv: any, i: number) => {
    const name = customers[inv.customer_id] || "Unknown client"
    let overdue = ""
    if (inv.due_date) {
      const days = Math.floor((today.getTime() - new Date(inv.due_date).getTime()) / 86400000)
      overdue = days > 0 ? `, ${days}d overdue` : days === 0 ? ", due today" : `, due in ${-days}d`
    }
    return `${i + 1}) ${name} — ${inv.number} ${fmtMoney(inv.total)}${overdue}, last contact ${fmtDay(lastContact[inv.customer_id] || inv.sent_at)}`
  })
  const more = invoices.length > 10 ? `\n(+${invoices.length - 10} more in Invoicing)` : ""
  const totalOwed = invoices.reduce((s: number, i: any) => s + Number(i.total || 0), 0)
  const body =
    `Valet Waste morning digest — ${invoices.length} outstanding (${fmtMoney(totalOwed)}):\n` +
    lines.join("\n") + more +
    `\nReply with a name or number and I'll text them a payment link.`

  const staff = await sbGet(`profiles?select=full_name,phone,role&phone=not.is.null`)
  const recipients = staff.filter((s: any) => ["admin", "staff"].includes(s.role || ""))
  let sent = 0
  for (const s of recipients) {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to: s.phone, body, purpose: "digest", sentBy: "Trashy Randy" }),
    })
    const d = await r.json().catch(() => ({}))
    if (d?.ok) sent++
  }
  return `Digest of ${invoices.length} outstanding invoices texted to ${sent}/${recipients.length} staff.`
}

// ---- lawn_invoice_weekly_lines ----------------------------------------------
// Lawns are billed monthly, itemized per visit: each completed lawn stop from
// yesterday becomes a line item on the client's current-month draft invoice.
async function runLawnInvoiceLines(): Promise<string> {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const stops = await sbGet(
    `route_stops?check_out=not.is.null&select=id,property_id,routes!inner(service_date,business_line),properties(address,price,customer_id)&routes.business_line=eq.lawn&routes.service_date=eq.${yesterday}`,
  )
  if (!stops.length) return `No completed lawn stops on ${yesterday}.`
  const monthStart = yesterday.slice(0, 8) + "01"
  let added = 0
  let skipped = 0
  for (const s of stops) {
    const p = s.properties
    if (!p?.customer_id || p.price == null) { skipped++; continue }
    let inv = (await sbGet(
      `invoices?customer_id=eq.${p.customer_id}&status=eq.draft&created_at=gte.${monthStart}&select=id,subtotal,discount&order=created_at.desc&limit=1`,
    ))[0]
    if (!inv) inv = (await sbPost("invoices", { customer_id: p.customer_id, status: "draft", subtotal: 0, total: 0, discount: 0 }))[0]
    const desc = `Lawn care — ${p.address} — ${yesterday}`
    const dup = await sbGet(`invoice_line_items?invoice_id=eq.${inv.id}&description=eq.${encodeURIComponent(desc)}&select=id&limit=1`)
    if (dup.length) { skipped++; continue }
    const last = await sbGet(`invoice_line_items?invoice_id=eq.${inv.id}&select=position&order=position.desc.nullslast&limit=1`)
    await sbPost("invoice_line_items", {
      invoice_id: inv.id, description: desc, quantity: 1,
      unit_price: p.price, amount: p.price, position: ((last[0]?.position ?? -1) + 1),
    })
    const subtotal = Number(inv.subtotal || 0) + Number(p.price)
    await sbPatch(`invoices?id=eq.${inv.id}`, { subtotal, total: Math.max(0, subtotal - Number(inv.discount || 0)) })
    added++
  }
  return `Added ${added} lawn line item(s) for ${yesterday}${skipped ? `, skipped ${skipped}` : ""}.`
}

// ---- HTTP entry -------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  // Auth: service key (cron) OR a signed-in staff user (Run now button).
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
  if (token !== SERVICE_KEY) {
    const ures = token
      ? await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
      : null
    if (!ures || !ures.ok) return json({ error: "Sign in required." }, 401)
    const uid = (await ures.json())?.id
    const prof = uid ? await sbGet(`profiles?id=eq.${uid}&select=role`) : []
    if (!["admin", "staff"].includes(prof?.[0]?.role)) return json({ error: "Staff only." }, 403)
  }

  let kindFilter: string | null = null
  try { kindFilter = (await req.json())?.kind ?? null } catch (_e) { /* run all */ }

  try {
    let autos = await sbGet(`automations?status=eq.enabled&select=id,kind,name`)
    if (kindFilter) autos = autos.filter((a: any) => a.kind === kindFilter)
    if (!autos.length) return json({ ok: true, ran: [], note: kindFilter ? `No enabled automation '${kindFilter}'.` : "No enabled automations." })

    const ran: Array<{ kind: string; result: string }> = []
    for (const a of autos) {
      let result = "Unknown automation kind — nothing to run."
      try {
        if (a.kind === "outstanding_digest") result = await runOutstandingDigest()
        if (a.kind === "lawn_invoice_weekly_lines") result = await runLawnInvoiceLines()
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`
      }
      await sbPatch(`automations?id=eq.${a.id}`, { last_run_at: new Date().toISOString(), last_result: result, updated_at: new Date().toISOString() })
      ran.push({ kind: a.kind, result })
    }
    return json({ ok: true, ran })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
