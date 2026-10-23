// Announcements — bulk text/email blasts to filtered customer audiences.
//
// The browser (Announcements tab) computes the audience from the loaded
// customer list and calls this in chunks of ~75 recipients:
//
//   POST { action: "send", channel: "sms"|"email"|"both", subject?, body,
//         recipients: [{ id, name, phone, email }], audienceLabel, filters,
//         sentByName, create }
//
//   create: true on the first chunk also inserts the history row
//   (announcements table, mig 0067); later chunks accumulate their counts
//   onto it. History writes are best-effort — the send never depends on them.
//
// Texts go out through RingCentral (Telnyx fallback) with the same rules as
// the `sms` function: the global pause is honored (customer-facing purposes
// are never pause-exempt) and per-customer opt-outs are re-checked here in
// one batched query, even though the browser already filtered them. Every
// attempt receipts into sms_messages / email_messages with purpose
// "announcement", so per-message records show up in the Comms tab.
//
// The caller must be a signed-in staff member (profiles.role admin|staff).
// Deploy WITH JWT verification (default — no --no-verify-jwt):
//   supabase functions deploy announcements

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

async function rest(path: string, method = "GET", body?: unknown): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: restHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  if (!r.ok) throw new Error((data && data.message) || `REST ${r.status}`)
  return data
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

// {firstName} / {name} / {company} — same placeholders the CRM templates use.
function renderBody(tpl: string, vars: { name: string; company: string }): string {
  const first = vars.name.trim().split(/\s+/)[0] || ""
  return String(tpl || "")
    .replace(/\{firstName\}/g, first || "there")
    .replace(/\{name\}/g, vars.name || "there")
    .replace(/\{company\}/g, vars.company)
}

function e164(raw: string): string {
  if (!raw) return raw
  const t = raw.trim()
  if (t.startsWith("+")) return "+" + t.slice(1).replace(/\D/g, "")
  const digits = t.replace(/\D/g, "")
  if (digits.length === 10) return "+1" + digits
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits
  return "+" + digits
}

// ---- Providers ---------------------------------------------------------------

async function rcToken(server: string, clientId: string, clientSecret: string, jwt: string): Promise<string> {
  const basic = btoa(`${clientId}:${clientSecret}`)
  const r = await fetch(`${server.replace(/\/+$/, "")}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`RingCentral auth ${r.status}: ${d?.error_description || d?.message || JSON.stringify(d)}`)
  return d.access_token as string
}

async function rcSend(server: string, token: string, from: string, to: string, text: string) {
  const r = await fetch(`${server.replace(/\/+$/, "")}/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`RingCentral send ${r.status}: ${d?.message || JSON.stringify(d)}`)
  return d
}

async function telnyxSend(from: string, to: string, text: string) {
  const key = Deno.env.get("TELNYX_API_KEY")
  if (!key) throw new Error("Telnyx fallback isn't configured (TELNYX_API_KEY not set).")
  const r = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, text }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`Telnyx send ${r.status}: ${d?.errors?.[0]?.detail || JSON.stringify(d)}`)
  return d
}

// Best-effort receipts — a logging failure must never break the send.
async function logSms(row: Record<string, unknown>) {
  try { await fetch(`${SUPABASE_URL}/rest/v1/sms_messages`, { method: "POST", headers: restHeaders, body: JSON.stringify(row) }) } catch (_e) {}
}
async function logEmail(row: Record<string, unknown>) {
  try { await fetch(`${SUPABASE_URL}/rest/v1/email_messages`, { method: "POST", headers: restHeaders, body: JSON.stringify(row) }) } catch (_e) {}
}

// SendGrid plain-text-as-HTML customer email (same layout as the reminder
// emails). Returns null on success; throws with the SendGrid detail on failure.
async function sendEmail(to: string, subject: string, text: string, company: string, customerId: string | null, sentByName: string | null) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const from = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px 16px;color:#1a2420">` +
    `<p style="font-size:15px;line-height:1.65;white-space:pre-wrap">${escapeHtml(text)}</p>` +
    `<p style="font-size:12.5px;color:#7c8a82;margin-top:18px">— ${escapeHtml(company)}</p></div>`
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: company }, subject, content: [{ type: "text/html", value: html }] }),
  })
  const base = { to_email: to, from_email: from, subject, body_text: text, body_html: html, purpose: "announcement", customer_id: customerId, sent_by: sentByName, related_type: "announcement" }
  if (!r.ok) {
    const msg = `SendGrid ${r.status}: ${await r.text()}`
    await logEmail({ ...base, status: "failed", error: msg.slice(0, 500) })
    throw new Error(msg)
  }
  await logEmail({ ...base, status: "sent" })
}

// ---- History row (announcements table, mig 0067 — best-effort) ---------------

async function writeHistory(create: boolean, fields: Record<string, unknown>, counts: Record<string, number>) {
  try {
    if (create) {
      await rest("announcements", "POST", { ...fields, counts })
    } else {
      // Accumulate onto the newest announcement row from this sender.
      const rows = await rest(`announcements?order=created_at.desc&limit=1&select=id,counts`)
      if (rows?.[0]?.id) {
        const prev = rows[0].counts || {}
        const merged: Record<string, number> = {}
        for (const k of Object.keys(counts)) merged[k] = (Number(prev[k]) || 0) + (counts[k] || 0)
        await rest(`announcements?id=eq.${rows[0].id}`, "PATCH", { counts: merged })
      }
    }
  } catch (_e) { /* table not migrated yet, or write failed — never block the send */ }
}

// ---- Send --------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    // Signed-in staff only (the browser sends the session JWT automatically).
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    if (!token) return json({ error: "Not signed in." }, 401)
    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
    if (!ures.ok) return json({ error: "Invalid session." }, 401)
    const caller = await ures.json()
    const rows = await rest(`profiles?id=eq.${caller?.id}&select=role`)
    const role = rows?.[0]?.role
    if (role !== "admin" && role !== "staff") return json({ error: "Staff only." }, 403)

    const payload = await req.json()
    if (payload.action !== "send") return json({ error: "Unknown action." }, 400)

    const { channel, subject, body, recipients, audienceLabel, filters, sentByName, create } = payload
    const cleanBody = String(body || "").trim()
    const list: any[] = Array.isArray(recipients) ? recipients : []
    if (!cleanBody) return json({ error: "The message body is empty." }, 400)
    if (!list.length) return json({ error: "No recipients." }, 400)

    const settings = (await rest("app_settings?id=eq.1&select=sms_enabled,sms_paused,rc_client_id,rc_server_url,sms_from_number,company_name"))[0] || {}
    const company = settings.company_name || "Valet Waste FL"

    const counts = { sentSms: 0, failedSms: 0, pausedSms: 0, skippedOptOut: 0, sentEmail: 0, failedEmail: 0 }
    const smsFailures: Array<{ customerId: string | null; name: string; phone: string; error: string }> = []
    const emailFailures: Array<{ customerId: string | null; name: string; email: string; error: string }> = []
    const warnings: string[] = []
    const wantSms = channel === "sms" || channel === "both"
    const wantEmail = channel === "email" || channel === "both"

    // --- Opt-out re-check (one batched query; the browser filters too). ----
    const optOut = new Set<string>()
    const ids = list.map((r) => String(r.id || "")).filter(Boolean)
    if (wantSms && ids.length) {
      try {
        const or = `id.in.(${ids.join(",")})`
        const cust = await rest(`customers?${or}&select=id,notify_on_service&limit=1000`)
        for (const c of cust || []) if (c.notify_on_service === false) optOut.add(c.id)
      } catch (_e) { /* lookup failure must never block legitimate sends */ }
    }

    // --- Texts -------------------------------------------------------------
    if (wantSms) {
      const smsTargets = list.filter((r) => r.phone && !optOut.has(String(r.id || "")))
      if (settings.sms_paused) {
        warnings.push("Texting is paused — no texts were sent (logged as paused).")
        for (const r of smsTargets) {
          await logSms({ direction: "out", provider: "paused", to_number: e164(r.phone), body: cleanBody, status: "paused", customer_id: r.id || null, purpose: "announcement", sent_by: sentByName || null })
          counts.pausedSms++
        }
      } else if (settings.sms_enabled && settings.rc_client_id && settings.sms_from_number) {
        const secrets = (await rest("sms_secrets?id=eq.1&select=rc_client_secret,rc_jwt"))[0] || {}
        const server = String(settings.rc_server_url || "https://platform.ringcentral.com")
        const from = e164(String(settings.sms_from_number))
        let token: string | null = null
        if (secrets.rc_client_secret && secrets.rc_jwt) {
          try { token = await rcToken(server, String(settings.rc_client_id), String(secrets.rc_client_secret), String(secrets.rc_jwt)) }
          catch (e) { warnings.push(`${e instanceof Error ? e.message : String(e)} — trying fallback.`) }
        }
        if (!token && !Deno.env.get("TELNYX_API_KEY")) {
          warnings.push("RingCentral credentials are missing and no Telnyx fallback is set — no texts were sent.")
        } else {
          // One message at a time, ~1.4/sec ceiling. RingCentral throttles
          // bulk sending hard — the 5-parallel/250ms burst of 2026-10-22 got
          // ~48 texts out before every remaining send was rejected.
          const rateLimited = (msg: string) => /429|rate limit|too many/i.test(msg)
          for (let i = 0; i < smsTargets.length; i++) {
            const r = smsTargets[i]
            const text = renderBody(cleanBody, { name: String(r.name || ""), company })
            const toNum = e164(r.phone)
            const base = { direction: "out", to_number: toNum, from_number: from, body: text, customer_id: r.id || null, purpose: "announcement", sent_by: sentByName || null }
            const sendRc = async () => {
              const d = await rcSend(server, token!, from, toNum, text)
              await logSms({ ...base, provider: "ringcentral", status: "sent", external_id: d?.id ? String(d.id) : null })
              counts.sentSms++
            }
            let sent = false
            let rcErr: string | null = null
            if (token) {
              try {
                await sendRc()
                sent = true
              } catch (e) {
                rcErr = errMsg(e)
                if (rateLimited(rcErr)) {
                  await sleep(4000) // throttled — back off, then one patient retry
                  try {
                    await sendRc()
                    sent = true
                  } catch (e2) { rcErr = errMsg(e2) }
                }
              }
            }
            if (!sent && Deno.env.get("TELNYX_API_KEY")) {
              try {
                const d = await telnyxSend(from, toNum, text)
                await logSms({ ...base, provider: "telnyx", status: "sent", external_id: d?.data?.id ? String(d.data.id) : null })
                counts.sentSms++
                sent = true
              } catch (e) {
                // Log BOTH providers' reasons — the fallback's error alone
                // hides why RingCentral (the primary) refused the send.
                const err = `${rcErr ? `${rcErr} · ` : ""}Telnyx: ${errMsg(e)}`
                await logSms({ ...base, provider: "ringcentral", status: "failed", error: err.slice(0, 500) })
                counts.failedSms++
                smsFailures.push({ customerId: r.id || null, name: String(r.name || ""), phone: toNum, error: err.slice(0, 300) })
              }
            } else if (!sent) {
              const err = rcErr || "No SMS provider available"
              await logSms({ ...base, provider: "ringcentral", status: "failed", error: err.slice(0, 500) })
              counts.failedSms++
              smsFailures.push({ customerId: r.id || null, name: String(r.name || ""), phone: toNum, error: err.slice(0, 300) })
            }
            if (i + 1 < smsTargets.length) await sleep(700)
          }
        }
      } else {
        warnings.push("Texting isn't enabled in Settings — no texts were sent.")
      }
      if (optOut.size) counts.skippedOptOut = list.filter((r) => r.phone && optOut.has(String(r.id || ""))).length
    }

    // --- Emails --------------------------------------------------------------
    if (wantEmail) {
      const emailTargets = list.filter((r) => r.email)
      const subjectLine = String(subject || "").trim() || `A message from ${company}`
      if (!Deno.env.get("SENDGRID_API_KEY")) {
        warnings.push("SENDGRID_API_KEY is not configured — no emails were sent.")
      } else {
        for (let i = 0; i < emailTargets.length; i += 5) {
          const batch = emailTargets.slice(i, i + 5)
          await Promise.all(batch.map(async (r) => {
            const text = renderBody(cleanBody, { name: String(r.name || ""), company })
            try {
              await sendEmail(String(r.email), subjectLine, text, company, r.id || null, sentByName || null)
              counts.sentEmail++
            } catch (e) {
              counts.failedEmail++ /* receipt already logged */
              emailFailures.push({ customerId: r.id || null, name: String(r.name || ""), email: String(r.email), error: errMsg(e).slice(0, 300) })
            }
          }))
          if (i + 5 < emailTargets.length) await sleep(150)
        }
      }
    }

    await writeHistory(!!create, {
      channel: channel === "sms" || channel === "email" || channel === "both" ? channel : "both",
      audience_label: String(audienceLabel || "audience"),
      filters: filters || {},
      subject: subject ? String(subject) : null,
      body: cleanBody,
      sent_by: caller?.id || null,
      sent_by_name: String(sentByName || "Staff"),
    }, counts)

    return json({ ok: true, ...counts, smsFailures, emailFailures, warnings })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) })
  }
})
