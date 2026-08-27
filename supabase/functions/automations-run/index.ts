// Automation runner — executes enabled rows from the `automations` table.
//
// Called by pg_cron each morning (service key bearer) or by the Automations
// tab's "Run now" (staff user token). Currently implements:
//   • outstanding_digest — texts staff a summary of unpaid invoices with days
//     overdue and last-contact date; staff reply to Trashy Randy to act.
//   • auto_invoice_reminders — up to 5 configurable reminders per open invoice
//     (trigger timing, sms/email/push channels, merge-field templates).
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

  const n = await notifyStaff(body, "digest", "Morning digest — outstanding invoices")
  return `Digest of ${invoices.length} outstanding invoices: ${n.texted} texted, ${n.emailed} emailed (of ${n.total} staff).`
}

// ---- auto_invoice_reminders ---------------------------------------------------
// Up to 5 configurable reminders per open invoice; config lives on the
// automations row (kind 'auto_invoice_reminders').config.reminders — flat
// items { key, label, type: after_sent|before_due|after_due, days, sms, email,
// push, template }. Templates merge [customer name] / [invoice link] / etc.
// Each reminder fires at most once per invoice (invoice_reminder_sends unique
// key); when several are due the same day only the LAST (most escalated)
// sends, so a customer never gets two reminder messages in one day.
const PORTAL_ORIGIN = Deno.env.get("PORTAL_ORIGIN") || "https://valet-waste-crm.vercel.app"

function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z")
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const fmtNiceDay = (v: string | null | undefined) => {
  if (!v) return ""
  try { return new Date(String(v).length === 10 ? v + "T12:00:00Z" : v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) } catch { return String(v) }
}
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
function renderTemplate(tpl: string, f: Record<string, string>): string {
  let out = tpl
  for (const [k, v] of Object.entries(f)) out = out.split(`[${k}]`).join(v)
  return out
}

async function sendCustomerEmail(to: string, subject: string, text: string, payUrl: string, amount: string, company: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const from = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px 16px;color:#1a2420">` +
    `<p style="font-size:15px;line-height:1.65;white-space:pre-wrap">${escapeHtml(text)}</p>` +
    `<a href="${payUrl}" style="display:inline-block;background:#1f7a4d;color:#fff;text-decoration:none;font-weight:700;font-size:15px;border-radius:9px;padding:12px 24px;margin:10px 0 6px">Pay ${escapeHtml(amount)} now</a>` +
    `<p style="font-size:12px;color:#7c8a82;line-height:1.6">Or paste this link into your browser:<br>${payUrl}</p>` +
    `<p style="font-size:12.5px;color:#7c8a82;margin-top:18px">— ${escapeHtml(company)}</p></div>`
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: company },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

// Expo push to the customer's registered app tokens (customer-keyed rows on
// push_tokens; staff profile tokens are intentionally not used here).
async function sendCustomerPush(customerId: string, title: string, body: string, url: string): Promise<number> {
  const tokens = await sbGet(`push_tokens?customer_id=eq.${customerId}&select=token&limit=20`)
  let sent = 0
  for (const t of tokens) {
    try {
      const r = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: t.token, title, body, sound: "default", data: { url } }),
      })
      if (r.ok) sent++
    } catch (_e) { /* best effort per token */ }
  }
  return sent
}

async function runInvoiceReminders(auto: any): Promise<string> {
  const rules: any[] = (auto?.config?.reminders || []).filter((r: any) =>
    ["after_sent", "before_due", "after_due"].includes(r?.type) && Number.isFinite(Number(r?.days)) && String(r?.template || "").trim())
  if (!rules.length) return "No reminders configured — nothing to run."

  const today = etToday()
  const invoices = await sbGet(`invoices?status=eq.sent&select=id,number,total,due_date,issue_date,sent_at,customer_id&order=due_date.asc.nullslast&limit=500`)
  if (!invoices.length) return "No open invoices — nothing to remind."

  const custIds = [...new Set(invoices.map((i: any) => i.customer_id).filter(Boolean))]
  const customers: Record<string, any> = {}
  for (const c of await sbGet(`customers?id=in.(${custIds.join(",")})&select=id,name,email,phone,portal_slug`)) customers[c.id] = c
  const settings = (await sbGet(`app_settings?id=eq.1&select=company_name`))[0] || {}
  const company = settings.company_name || "Valet Waste FL"

  // Service date per invoice = earliest stop date among its line items
  // (per-stop billing), falling back to the issue date.
  const serviceDate: Record<string, string> = {}
  try {
    const lines = await sbGet(`invoice_line_items?invoice_id=in.(${invoices.map((i: any) => i.id).join(",")})&select=invoice_id,route_stops(routes(service_date))&limit=2000`)
    for (const l of lines) {
      const d = l?.route_stops?.routes?.service_date
      if (!d) continue
      if (!serviceDate[l.invoice_id] || d < serviceDate[l.invoice_id]) serviceDate[l.invoice_id] = d
    }
  } catch (_e) { /* embedding unavailable → fall back to issue dates */ }

  const already = new Set<string>()
  for (const s of await sbGet(`invoice_reminder_sends?invoice_id=in.(${invoices.map((i: any) => i.id).join(",")})&select=invoice_id,reminder_key&limit=5000`)) {
    already.add(`${s.invoice_id}:${s.reminder_key}`)
  }

  let sent = 0, emailed = 0, texted = 0, pushed = 0, smsFellBack = 0, noContact = 0
  for (const inv of invoices) {
    const cust = customers[inv.customer_id]
    if (!cust || !cust.portal_slug) { noContact++; continue }
    const due = rules.filter((r, idx) => {
      if (already.has(`${inv.id}:${r.key || idx}`)) return false
      const base = r.type === "after_sent" ? String(inv.sent_at || "").slice(0, 10) : inv.due_date
      if (!base) return false
      const offset = r.type === "before_due" ? -Number(r.days) : Number(r.days)
      return today >= addDays(base.slice(0, 10), offset)
    })
    if (!due.length) continue
    const r = due[due.length - 1] // most escalated stage only — one message/day
    const rKey = r.key || String(rules.indexOf(r))

    const amount = fmtMoney(inv.total)
    const payUrl = `${PORTAL_ORIGIN}/?portal=${encodeURIComponent(cust.portal_slug)}&pay_invoice=${inv.id}`
    const text = renderTemplate(String(r.template), {
      "customer name": cust.name || "there",
      "invoice number": inv.number || "",
      "amount": amount,
      "due date": fmtNiceDay(inv.due_date) || "—",
      "issue date": fmtNiceDay(inv.issue_date),
      "service date": fmtNiceDay(serviceDate[inv.id] || inv.issue_date),
      "invoice link": payUrl,
      "company name": company,
    }).trim()

    let e = 0, t = 0, p = 0
    const emailOn = !!r.email && !!cust.email
    if (emailOn) {
      try { await sendCustomerEmail(cust.email, `Reminder: invoice ${inv.number} — ${amount}`, text, payUrl, amount, company); e++ } catch (_err) { /* try other channels */ }
    }
    if (r.sms && cust.phone) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send", to: cust.phone, body: text, customerId: cust.id, purpose: "reminder", sentBy: company }),
        })
        const d = await res.json().catch(() => ({}))
        if (d?.ok) t++
        else if (!emailOn && cust.email) {
          // Texting is paused (or failed) and email wasn't selected — fall
          // back to email so the reminder still goes out (logged as paused
          // in sms_messages by the sms fn).
          try { await sendCustomerEmail(cust.email, `Reminder: invoice ${inv.number} — ${amount}`, text, payUrl, amount, company); e++; smsFellBack++ } catch (_err) { /* best effort */ }
        }
      } catch (_err) { /* best effort */ }
    }
    if (r.push) {
      try { p = await sendCustomerPush(cust.id, company, text.slice(0, 180), payUrl) } catch (_err) { /* best effort */ }
    }
    if (e + t + p > 0) {
      sent++
      emailed += e
      texted += t
      pushed += p
      await sbPost("invoice_reminder_sends", { invoice_id: inv.id, reminder_key: rKey, channels: [e ? "email" : null, t ? "sms" : null, p ? "push" : null].filter(Boolean).join(","), detail: `${inv.number} → ${cust.name}` })
    }
  }

  const parts: string[] = []
  if (!sent) return `No reminders due today (${invoices.length} open invoices checked${noContact ? `, ${noContact} without portal contact` : ""}).`
  parts.push(`${sent} reminder${sent === 1 ? "" : "s"} sent`)
  const ch: string[] = []
  if (emailed) ch.push(`${emailed} emailed`)
  if (texted) ch.push(`${texted} texted`)
  if (pushed) ch.push(`${pushed} pushed`)
  if (smsFellBack) ch.push(`${smsFellBack} sms→email fallback`)
  return `${parts[0]} (${ch.join(", ")}) across ${invoices.length} open invoices.`
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
  const wdays = ["Sun", "Mon", "Tues", "Wed", "Thurs", "Fri", "Sat"]
  let added = 0
  let skipped = 0
  for (const s of stops) {
    const p = s.properties
    if (!p?.customer_id || p.price == null) { skipped++; continue }
    // One line per stop, ever — the stop_id unique index (mig 0043) is the
    // double-billing guard shared with the drivers' check-in/out popup.
    const dup = await sbGet(`invoice_line_items?stop_id=eq.${s.id}&select=id&limit=1`)
    if (dup.length) { skipped++; continue }
    let inv = (await sbGet(
      `invoices?customer_id=eq.${p.customer_id}&status=eq.draft&created_at=gte.${monthStart}&select=id,subtotal,discount&order=created_at.desc&limit=1`,
    ))[0]
    if (!inv) inv = (await sbPost("invoices", { customer_id: p.customer_id, status: "draft", subtotal: 0, total: 0, discount: 0 }))[0]
    const d = new Date(String(s.routes?.service_date || yesterday) + "T12:00:00Z")
    const title = `Week ${Math.ceil(d.getUTCDate() / 7)} ${wdays[d.getUTCDay()]} Lawn Care`
    const desc = `Lawn care — ${p.address} — ${yesterday}`
    const last = await sbGet(`invoice_line_items?invoice_id=eq.${inv.id}&select=position&order=position.desc.nullslast&limit=1`)
    await sbPost("invoice_line_items", {
      invoice_id: inv.id, stop_id: s.id, title, description: desc, quantity: 1,
      unit_price: p.price, amount: p.price, position: ((last[0]?.position ?? -1) + 1),
    })
    const subtotal = Number(inv.subtotal || 0) + Number(p.price)
    await sbPatch(`invoices?id=eq.${inv.id}`, { subtotal, total: Math.max(0, subtotal - Number(inv.discount || 0)) })
    added++
  }
  return `Added ${added} lawn line item(s) for ${yesterday}${skipped ? `, skipped ${skipped}` : ""}.`
}

// ---- draft_invoice_monthend_reminder ----------------------------------------
// Per-stop billing (2026-08-26) means monthly draft invoices accumulate lines
// all month. On the last day of the month (Eastern), remind staff to review
// and send the open drafts — autopay charges them on the 1st, but only after
// they've been sent. Texts staff (via the paused-aware sms fn) and always
// records the summary in automations.last_result (visible in the app).
async function runDraftInvoiceReminder(): Promise<string> {
  const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
  const tomorrow = new Date(nowEt.getTime() + 86400000)
  if (tomorrow.getMonth() === nowEt.getMonth()) {
    return `Not month-end (ET is ${nowEt.toISOString().slice(0, 10)}) — nothing to do.`
  }
  const drafts = await sbGet(`invoices?status=eq.draft&select=id,number,total,customer_id&order=total.desc&limit=50`)
  if (!drafts.length) return "No open draft invoices — nothing to send."
  const custIds = [...new Set(drafts.map((i: any) => i.customer_id).filter(Boolean))]
  const names: Record<string, string> = {}
  for (const c of await sbGet(`customers?id=in.(${custIds.join(",")})&select=id,name`)) names[c.id] = c.name
  const totalDue = drafts.reduce((s: number, i: any) => s + Number(i.total || 0), 0)
  const body =
    `Heads up — ${drafts.length} draft invoice(s) totaling ${fmtMoney(totalDue)} are still unsent ` +
    `(top: ${names[drafts[0].customer_id] || "?"} ${drafts[0].number} ${fmtMoney(drafts[0].total)}). ` +
    `Autopay runs tomorrow and only charges SENT invoices — review and send today's drafts in Invoicing.`
  const n = await notifyStaff(body, "digest", "Month-end reminder — unsent draft invoices")
  return `Month-end reminder: ${drafts.length} draft invoice(s), ${fmtMoney(totalDue)} — ${n.texted} texted, ${n.emailed} emailed (of ${n.total} staff).`
}

// ---- autopay_charge_monthly -------------------------------------------------
// On the 1st (America/New_York) charge each consenting client's saved card for
// their open (sent) invoices issued before this month. Before charging, apply
// the 5th-pickup-week-free credit: any waste property whose pickup day lands 5
// times in the invoice's issue month gets one visit-price credited. Randy
// texts admins the results.

// ---- Run Merchant (Run Payments) helpers ------------------------------------
// Replaces Stripe for the off-session autopay charge. The api_key (1h TTL) is
// minted from the long-lived refresh_token, cached in app_settings.
const RUN_HOSTS = {
  uat: "https://javelin-staging.runpayments.io",
  production: "https://javelin.runpayments.io",
}
function runHost(env?: string | null) {
  return RUN_HOSTS[(env === "uat" ? "uat" : "production") as keyof typeof RUN_HOSTS]
}
async function runAccessToken(): Promise<{ token: string; mid: string; env: string }> {
  const s = (await sbGet(`app_settings?id=eq.1&select=run_mid,run_refresh_token,run_api_key,run_api_key_expires_at,run_env`))[0] || {}
  const mid = s.run_mid || ""
  const env = s.run_env === "uat" ? "uat" : "production"
  if (!mid || !s.run_refresh_token) throw new Error("Run Merchant isn't configured.")
  const exp = s.run_api_key_expires_at ? new Date(s.run_api_key_expires_at as string).getTime() : 0
  if (s.run_api_key && exp - Date.now() > 5 * 60 * 1000) return { token: s.run_api_key as string, mid, env }
  const { token } = await runKeyRefresh(s)
  return { token, mid, env }
}

// Shared refresh: both shapes, plus the refresh-token-only shape (a stored
// api_key can be expired/purged at Run — 2026-08-26 — and that dead key must
// not block a still-valid refresh token). Persists successors via
// persistRunTokens (backup row on failure).
async function runKeyRefresh(s: Record<string, unknown>): Promise<{ token: string }> {
  const env = s.run_env === "uat" ? "uat" : "production"
  const rt = String(s.run_refresh_token || "")
  const attempts = s.run_api_key
    ? [{ bearer: String(s.run_api_key), token: rt }, { bearer: rt, token: String(s.run_api_key) }]
    : []
  attempts.push({ bearer: rt, token: rt })
  let d: Record<string, unknown> = {}
  let ok = false
  let status = 0
  for (const a of attempts) {
    const r = await fetch(`${runHost(env)}/api/v1/api_keys/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: a.token }),
    })
    d = await r.json().catch(() => ({}))
    if (r.ok) { ok = true; break }
    status = r.status
  }
  if (!ok) throw new Error((d?.message as string) || (d?.error as string) || `Run Merchant key refresh failed: ${status}`)
  await persistRunTokens(d)
  return { token: d.api_key as string }
}

// Proactive keep-warm refresh (cron every 15 min, mig 0046): refreshes unless
// the key was rotated seconds ago — the lazy on-demand refresh can't recover
// once Run purges an expired key, which is what killed 2026-08-20/25/26
// (outages #1-3). NOTE: refresh only works with the still-live api_key in the
// body (shape2), so the threshold must guarantee a healthy margin across a
// missed tick — a <15-min threshold with 30-min ticks left a 16-min-remaining
// gap on 2026-08-26 (outage #4, same day) and the key died. Skip only when
// the key has >50 min left (i.e. basically just rotated); every successful
// tick rotation buys a full fresh hour and pushes the refresh token +30d.
async function runRunKeyKeepwarm(): Promise<string> {
  const s = (await sbGet(`app_settings?id=eq.1&select=run_mid,run_refresh_token,run_api_key,run_api_key_expires_at,run_env`))[0] || {}
  if (!s.run_mid || !s.run_refresh_token) return "Run Merchant isn't configured — skipped."
  const exp = s.run_api_key_expires_at ? new Date(s.run_api_key_expires_at as string).getTime() : 0
  const remaining = exp - Date.now()
  if (s.run_api_key && remaining > 50 * 60 * 1000) {
    return `Key still fresh (${Math.round(remaining / 60000)} min left) — no refresh needed.`
  }
  try {
    await runKeyRefresh(s)
    return "Run API key refreshed proactively."
  } catch (e) {
    // Only page admins when the key is actually dead or about to die — and at
    // most every 6h (shared run_creds_alerted_at marker with the portal fn).
    if (!s.run_api_key || remaining <= 0) {
      const a = (await sbGet(`app_settings?id=eq.1&select=run_creds_alerted_at`))[0] || {}
      const last = a.run_creds_alerted_at ? new Date(a.run_creds_alerted_at as string).getTime() : 0
      if (Date.now() - last > 6 * 3600000) {
        await sbPatch(`app_settings?id=eq.1`, { run_creds_alerted_at: new Date().toISOString() }).catch(() => {})
        await notifyStaff(
        `Run Payments credentials are DEAD — card saves and autopay charges are failing. ` +
        `Fix: Run Merchant portal → Settings → Developer API → Create, then give the new set to the CRM ` +
        `(Settings → Payments). Error: ${e instanceof Error ? e.message : String(e)}`,
        "autopay",
        "ACTION NEEDED: Run Payments credentials dead",
      ).catch(() => {})
      }
    }
    return `Refresh failed: ${e instanceof Error ? e.message : String(e)}`
  }
}

// A Run refresh consumes the stored refresh token — if this write silently
// failed the successor would be lost forever and every fn would 401. Back it
// up to run_webhook_events (service-role only) on failure so it can be recovered.
async function persistRunTokens(d: Record<string, unknown>) {
  const body = {
    run_api_key: d.api_key,
    run_refresh_token: d.refresh_token,
    run_api_key_expires_at: new Date(Number(d.api_key_expires_at) * 1000).toISOString(),
    run_refresh_token_expires_at: new Date(Number(d.refresh_token_expires_at) * 1000).toISOString(),
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
  if (!r.ok) {
    console.error("Run token persist failed", r.status, await r.text())
    try {
      await sbPost("run_webhook_events", { event_type: "debug.token_persist_failed", payload: d, webhook_id: `debug-${crypto.randomUUID()}` })
    } catch (_e) { console.error("Run token persist backup also failed", _e) }
  }
}
async function runCharge(env: string, token: string, body: Record<string, unknown>) {
  const r = await fetch(`${runHost(env)}/api/v1/charge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.message || d?.resp_text || `Run Merchant charge failed: ${r.status}`)
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

// ---- staff notifications with email fallback ---------------------------------
// Texts via the sms fn; while texting is PAUSED (RingCentral limit, 2026-08-26)
// — or when a staffer has no phone — the same message goes out by email via
// SendGrid instead (project-level secret, same one the payments fn uses).
async function sendStaffEmail(to: string, subject: string, body: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const from = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: "Trashy Randy" },
      subject,
      content: [{ type: "text/plain", value: body }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

async function notifyStaff(body: string, purpose: string, subject: string): Promise<{ texted: number; emailed: number; total: number }> {
  const staff = await sbGet(`profiles?select=full_name,phone,email,role&or=(phone.not.is.null,email.not.is.null)`)
  const recipients = staff.filter((s: any) => ["admin", "staff"].includes(s.role || ""))
  let texted = 0
  let emailed = 0
  for (const s of recipients) {
    let sentText = false
    if (s.phone) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send", to: s.phone, body, purpose, sentBy: "Trashy Randy" }),
        })
        const d = await r.json().catch(() => ({}))
        if (d?.ok) { texted++; sentText = true }
      } catch (_e) { /* fall through to email */ }
    }
    if (!sentText && s.email) {
      try { await sendStaffEmail(s.email, subject, body); emailed++ } catch (_e) { /* best effort */ }
    }
  }
  return { texted, emailed, total: recipients.length }
}

async function textAdminsRandy(body: string) {
  await notifyStaff(body, "autopay", "Autopay results")
}

async function runAutopayCharge(force = false): Promise<string> {
  const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  if (nyDate.slice(8) !== "01" && !force) return `Skipped — autopay charges run on the 1st (today is ${nyDate}).`
  const monthStart = nyDate.slice(0, 8) + "01"

  const settings = (await sbGet(`app_settings?id=eq.1&select=run_mid`))[0] || {}
  if (!settings.run_mid) return "Skipped — Run Merchant isn't configured."

  const customers = await sbGet(
    `customers?autopay_consent=is.true&run_vault_id=not.is.null&select=id,name,run_vault_id,run_vault_holder_id`,
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

        // ---- charge the saved card (off-session, merchant-initiated) ----
        const cents = Math.round(newTotal * 100)
        if (cents < 50) continue
        const { token, mid, env } = await runAccessToken()
        const res = await runCharge(env, token, {
          mid,
          amount: cents,
          vault_id: cust.run_vault_id,
          vault_holder_id: cust.run_vault_holder_id || undefined,
          capture: "Y",
          currency: "USD",
          cof: "M", // merchant-initiated
          cof_sched: "Y", // scheduled recurring
          invoice_id: String(inv.id),
          order_id: String(inv.id),
        })
        if (res.result === "A") {
          await sbPatch(`invoices?id=eq.${inv.id}`, {
            status: "paid", paid_at: new Date().toISOString(),
            run_paid_at: new Date().toISOString(), run_trans_id: String(res.trans_id),
          })
          charged++
          totalCharged += newTotal
        } else {
          failed++
          failLines.push(`${cust.name} ${inv.number}: ${res.resp_text || res.result || "declined"}`)
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

// ---- scheduled_sends ---------------------------------------------------------
// Deliver queued invoice sends (sms/email/both) whose Eastern-time moment has
// arrived. Called every 5 minutes by the scheduled-invoice-sends cron.
async function runScheduledInvoiceSends(): Promise<string> {
  const due = await sbGet(
    `invoice_scheduled_sends?status=eq.pending&send_at=lte.${new Date().toISOString()}&select=id,invoice_id,channel&order=send_at.asc&limit=20`,
  )
  if (!due.length) return "No scheduled sends due."

  const settings = (await sbGet(`app_settings?id=eq.1&select=company_name,sms_invoice_template`))[0] || {}
  const company = settings.company_name || "Valet Waste FL"
  const DEFAULT_TPL = "Hi {customerName}, invoice {invoiceNumber} for {total} is ready. Pay here: {payLink} — {companyName}"

  let sent = 0
  let skipped = 0
  let failed = 0
  for (const row of due) {
    try {
      const inv = (await sbGet(
        `invoices?id=eq.${row.invoice_id}&select=id,number,status,total,payment_url,customer_id,customers(name,phone,email,portal_slug)`,
      ))[0]
      if (!inv || inv.status === "paid" || inv.status === "void") {
        await sbPatch(`invoice_scheduled_sends?id=eq.${row.id}`, { status: "cancelled", last_error: `invoice ${inv ? inv.status : "deleted"} — nothing to send` })
        skipped++
        continue
      }
      const cust = inv.customers || {}

      // Mint the pay link on first send (payments fn also marks the invoice sent).
      let url = inv.payment_url
      if (!url) {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/payments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
          body: JSON.stringify({ action: "payment_url", invoice_id: inv.id }),
        })
        const d = await r.json().catch(() => ({} as any))
        if (!d?.url) throw new Error(d?.error || "could not create payment link")
        url = d.url
      }

      let smsPaused = false
      if ((row.channel === "sms" || row.channel === "both") && cust.phone) {
        const tpl = settings.sms_invoice_template || DEFAULT_TPL
        const body = String(tpl).replace(/\{(\w+)\}/g, (m, k) => {
          const vars: Record<string, string> = {
            customerName: cust.name || "there",
            invoiceNumber: String(inv.number),
            total: "$" + Number(inv.total || 0).toFixed(2),
            payLink: url,
            companyName: company,
          }
          return vars[k] != null ? vars[k] : m
        })
        const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
          body: JSON.stringify({ action: "send", to: cust.phone, body, customerId: inv.customer_id, purpose: "invoice" }),
        })
        const d = await r.json().catch(() => ({}))
        if (d?.paused) {
          // Texting is globally paused (RingCentral limit): don't fail the send —
          // deliver by email instead when the customer has one.
          smsPaused = true
        } else if (!d?.ok) {
          throw new Error(d?.error || "SMS send failed")
        }
      }

      if (smsPaused && row.channel === "sms" && !cust.email) {
        await sbPatch(`invoice_scheduled_sends?id=eq.${row.id}`, { status: "failed", last_error: "Texting paused (RingCentral limit) and this customer has no email on file" })
        failed++
        continue
      }

      if (row.channel === "email" || row.channel === "both" || smsPaused) {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/payments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
          body: JSON.stringify({ action: "email_invoice", invoice_id: inv.id }),
        })
        const d = await r.json().catch(() => ({} as any))
        if (!d?.ok) throw new Error(d?.error || "email send failed")
      }

      if (inv.status === "draft") await sbPatch(`invoices?id=eq.${inv.id}`, { status: "sent", sent_at: new Date().toISOString() })
      await sbPatch(`invoice_scheduled_sends?id=eq.${row.id}`, { status: "sent", sent_at: new Date().toISOString() })
      sent++
    } catch (e) {
      failed++
      await sbPatch(`invoice_scheduled_sends?id=eq.${row.id}`, { status: "failed", last_error: e instanceof Error ? e.message : String(e) })
    }
  }
  return `Scheduled sends: ${sent} delivered, ${skipped} skipped (paid/void), ${failed} failed.`
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
  let action: string | null = null
  try {
    const b = await req.json()
    action = b?.action ?? null
    kindFilter = b?.kind ?? null
    force = b?.force === true // only used by autopay for controlled testing
  } catch (_e) { /* run all */ }

  try {
    if (action === "scheduled_sends") {
      const result = await runScheduledInvoiceSends()
      return json({ ok: true, result })
    }
    if (action === "refresh_run_key") {
      const result = await runRunKeyKeepwarm()
      return json({ ok: true, result })
    }
    let autos = await sbGet(`automations?status=eq.enabled&select=id,kind,name,config`)
    if (kindFilter) autos = autos.filter((a: any) => a.kind === kindFilter)
    if (!autos.length) return json({ ok: true, ran: [], note: kindFilter ? `No enabled automation '${kindFilter}'.` : "No enabled automations." })

    const ran: Array<{ kind: string, result: string }> = []
    for (const a of autos) {
      let result = "Unknown automation kind — nothing to run."
      try {
        if (a.kind === "outstanding_digest") result = await runOutstandingDigest()
        if (a.kind === "auto_invoice_reminders") result = await runInvoiceReminders(a)
        if (a.kind === "lawn_invoice_weekly_lines") result = await runLawnInvoiceLines()
        if (a.kind === "draft_invoice_monthend_reminder") result = await runDraftInvoiceReminder()
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
