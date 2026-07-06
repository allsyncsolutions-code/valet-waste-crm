// Automation runner — executes enabled rows from the `automations` table.
//
// Called by pg_cron each morning (service key bearer) or by the Automations
// tab's "Run now" (staff user token). Currently implements:
//   • outstanding_digest — texts staff a summary of unpaid invoices with days
//     overdue and last-contact date; staff reply to Trashy Randy to act.
//   • lawn_invoice_weekly_lines — itemized per-visit lawn billing.
//   • autopay_charge_monthly — on the 1st, charge consenting clients' saved
//     cards for prior-month open invoices + 5th-week-free credit.
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

// ---- autopay_charge_monthly -------------------------------------------------
// On the 1st (America/New_York) charge each consenting client's saved card for
// their open (sent) invoices issued before this month. Before charging, apply
// the 5th-pickup-week-free credit: any waste property whose pickup day lands 5
// times in the invoice's issue month gets one visit-price credited. Randy
// texts admins the results.

function stripeForm(obj: Record<string, unknown>) {
  const p = new URLSearchParams()
  const add = (key: string, val: unknown) => {
    if (val === undefined || val === null) return
    if (typeof val === "object") {
      for (const k of Object.keys(val as Record<string, unknown>)) add(`${key}[${k}]`, (val as Record<string, unknown>)[k])
    } else {
      p.append(key, String(val))
    }
  }
  for (const k of Object.keys(obj)) add(k, obj[k])
  return p.toString()
}
async function stripeApi(path: string, opts: { method?: string; body?: Record<string, unknown>; account?: string } = {}) {
  const sk = Deno.env.get("STRIPE_SECRET_KEY")
  if (!sk) throw new Error("STRIPE_SECRET_KEY missing.")
  const headers: Record<string, string> = { Authorization: `Bearer ${sk}`, "Content-Type": "application/x-www-form-urlencoded" }
  if (opts.account) headers["Stripe-Account"] = opts.account
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: opts.method || "POST",
    headers,
    body: opts.body ? stripeForm(opts.body) : undefined,
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error?.message || `Stripe ${r.status}`)
  return d
}

// How many times does weekday `dow` (0=Sun..6=Sat) occur in year-month `ym` (YYYY-MM)?
function weekdayCountInMonth(ym: string, dow: number): number {
  const [y, m] = ym.split("-").map(Number)
  let count = 0
  const days = new Date(y, m, 0).getDate()
  for (let d = 1; d <= days; d++) if (new Date(y, m - 1, d).getDay() === dow) count++
  return count
}
const DOW: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }

async function textAdminsRandy(body: string) {
  const staff = await sbGet(`profiles?select=phone,role&phone=not.is.null&role=eq.admin`)
  for (const s of staff) {
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", to: s.phone, body, purpose: "autopay", sentBy: "Trashy Randy" }),
      })
    } catch (_e) { /* best effort */ }
  }
}

async function runAutopayCharge(force = false): Promise<string> {
  const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  if (nyDate.slice(8) !== "01" && !force) return `Skipped — autopay charges run on the 1st (today is ${nyDate}).`
  const monthStart = nyDate.slice(0, 8) + "01"

  const settings = (await sbGet(`app_settings?id=eq.1&select=stripe_account_id`))[0] || {}
  const account = settings.stripe_account_id
  if (!account) return "Skipped — no connected Stripe account."

  const customers = await sbGet(
    `customers?autopay_consent=is.true&autopay_pm_id=not.is.null&stripe_customer_id=not.is.null&select=id,name,stripe_customer_id,autopay_pm_id`,
  )
  if (!customers.length) return "No clients have autopay enabled."

  let charged = 0
  let credited = 0
  let failed = 0
  const failLines: string[] = []
  let totalCharged = 0

  for (const cust of customers) {
    const invoices = await sbGet(
      `invoices?customer_id=eq.${cust.id}&status=eq.sent&issue_date=lt.${monthStart}&select=id,number,subtotal,discount,total,issue_date&order=issue_date.asc&limit=12`,
    )
    if (!invoices.length) continue
    const props = await sbGet(
      `properties?customer_id=eq.${cust.id}&business_line=eq.waste&price=not.is.null&select=id,address,price,pickup_days`,
    )

    for (const inv of invoices) {
      try {
        // ---- 5th-week-free credit (once per invoice, keyed on description) ----
        const ym = String(inv.issue_date || monthStart).slice(0, 7)
        let credit = 0
        for (const p of props) {
          const days: string[] = Array.isArray(p.pickup_days) ? p.pickup_days : []
          const hasFifth = days.some((d) => {
            const dow = DOW[String(d).trim().toLowerCase()]
            return dow !== undefined && weekdayCountInMonth(ym, dow) === 5
          })
          if (hasFifth && Number(p.price) > 0) credit += Number(p.price)
        }
        let newTotal = Number(inv.total || 0)
        if (credit > 0) {
          const creditDesc = `5th pickup week free (autopay) — ${ym}`
          const existing = await sbGet(`invoice_line_items?invoice_id=eq.${inv.id}&description=eq.${encodeURIComponent(creditDesc)}&select=id&limit=1`)
          if (!existing.length) {
            credit = Math.min(credit, newTotal) // never push the invoice negative
            if (credit > 0) {
              const last = await sbGet(`invoice_line_items?invoice_id=eq.${inv.id}&select=position&order=position.desc.nullslast&limit=1`)
              await sbPost("invoice_line_items", {
                invoice_id: inv.id, description: creditDesc, quantity: 1,
                unit_price: -credit, amount: -credit, position: ((last[0]?.position ?? -1) + 1),
              })
              const subtotal = Number(inv.subtotal || 0) - credit
              newTotal = Math.max(0, subtotal - Number(inv.discount || 0))
              await sbPatch(`invoices?id=eq.${inv.id}`, { subtotal, total: newTotal })
              credited++
            }
          }
        }

        if (newTotal <= 0) {
          await sbPatch(`invoices?id=eq.${inv.id}`, { status: "paid", paid_at: new Date().toISOString() })
          continue
        }

        // ---- charge the saved card (off-session) ----
        const cents = Math.round(newTotal * 100)
        if (cents < 50) continue
        const pi = await stripeApi("payment_intents", {
          account,
          body: {
            amount: cents, currency: "usd",
            customer: cust.stripe_customer_id,
            payment_method: cust.autopay_pm_id,
            off_session: "true", confirm: "true",
            description: `Autopay — invoice ${inv.number} (${cust.name})`,
            metadata: { invoice_id: inv.id, invoice_number: inv.number, crm_customer_id: cust.id },
          },
        })
        if (pi.status === "succeeded") {
          await sbPatch(`invoices?id=eq.${inv.id}`, { status: "paid", paid_at: new Date().toISOString() })
          charged++
          totalCharged += newTotal
        } else {
          failed++
          failLines.push(`${cust.name} ${inv.number}: ${pi.status}`)
        }
      } catch (e) {
        failed++
        failLines.push(`${cust.name} ${inv.number}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const summary =
    `Autopay run for ${nyDate}: charged ${charged} invoice(s) totalling ${fmtMoney(totalCharged)}` +
    `${credited ? `, applied ${credited} 5th-week-free credit(s)` : ""}` +
    `${failed ? `, ${failed} FAILED — ${failLines.slice(0, 5).join(" | ")}` : ""}.`
  if (charged || failed || credited) {
    await textAdminsRandy(`💳 ${summary}${failed ? " Failed cards need a manual follow-up." : ""} — Trashy Randy`)
  }
  return summary
}

// ---- HTTP entry -------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  // Auth: service key, the internal cron token, or a signed-in staff user.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
  if (token !== SERVICE_KEY) {
    const internal = await sbGet(`internal_secrets?id=eq.1&select=cron_token`).catch(() => [])
    const cronToken = internal?.[0]?.cron_token
    if (!(cronToken && token === cronToken)) {
      const ures = token
        ? await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
        : null
      if (!ures || !ures.ok) return json({ error: "Sign in required." }, 401)
      const uid = (await ures.json())?.id
      const prof = uid ? await sbGet(`profiles?id=eq.${uid}&select=role`) : []
      if (!["admin", "staff"].includes(prof?.[0]?.role)) return json({ error: "Staff only." }, 403)
    }
  }

  let kindFilter: string | null = null
  let force = false
  try {
    const b = await req.json()
    kindFilter = b?.kind ?? null
    force = b?.force === true // only used by autopay for controlled testing
  } catch (_e) { /* run all */ }

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
        if (a.kind === "autopay_charge_monthly") result = await runAutopayCharge(force && kindFilter === "autopay_charge_monthly")
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
