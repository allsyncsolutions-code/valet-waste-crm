// New-property staff alert — fired by the CRM right after a staff member adds
// a property (customersData.addProperty). Tells the team a new service address
// went on the books: SMS to every admin profile (textAdmins pattern — no-ops
// while the global sms_paused switch is on), staff email to the same address
// list as the new_request_alerts automation, and an Expo push to staff devices.
//
// The property itself is already saved by the caller; this only alerts, so a
// failure here never blocks the save (the CRM toasts a warning instead).
//
// Auth: the CRM invokes this with the signed-in staff user's JWT (like
// manage-team / gmail-oauth). Anonymous calls are rejected.
//
// Deploy with JWT verification OFF (custom auth below):
//   supabase functions deploy notify-new-property --no-verify-jwt

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } })
}

// Global kill switch for a notification type (Notifications tab, mig 0065).
// Reads the app_settings.notification_toggles JSONB map; a missing key = ON.
async function notifEnabled(key: string): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=notification_toggles`, { headers: rest })
    const rows = await r.json()
    const t = (Array.isArray(rows) && rows[0]?.notification_toggles) || {}
    return t[key] !== false
  } catch (_e) { return true }
}

async function sbGet(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: rest })
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`)
  return await r.json()
}

// Caller must be a signed-in staff/admin user (mirrors staffFromAuthHeader in
// the portal fn).
async function staffFromAuthHeader(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
  if (!token || token === SERVICE_KEY) return false
  const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  })
  if (!ures.ok) return false
  const uid = (await ures.json())?.id
  if (!uid) return false
  const prof = await sbGet(`profiles?id=eq.${uid}&select=role`)
  return ["admin", "staff"].includes(prof?.[0]?.role)
}

// SMS to every admin with a phone on file (identical to the portal fn's
// textAdmins; the sms fn no-ops while texting is globally paused).
async function textAdmins(body: string) {
  let sent = 0
  try {
    const staff = await sbGet(`profiles?select=full_name,phone,role&phone=not.is.null&role=eq.admin`)
    for (const s of staff) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send", to: s.phone, body, purpose: "staff_alert", sentBy: "Trashy Randy" }),
        })
        if (r.ok) sent++
      } catch (_e) { /* best effort per admin */ }
    }
  } catch (_e) { /* never block on texting */ }
  return sent
}

async function sendStaffAlertEmail(to: string, subject: string, text: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com", name: "Trashy Randy" },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

// Expo push to staff-registered devices (push_tokens.profile_id set — the
// staff mobile app registers those).
async function pushStaffDevices(title: string, body: string): Promise<number> {
  const tokens = await sbGet(`push_tokens?profile_id=not.is.null&select=token&limit=50`)
  let sent = 0
  for (const t of tokens) {
    try {
      const r = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: t.token, title, body, sound: "default" }),
      })
      const d = await r.json().catch(() => ({} as any))
      const rec: any = Array.isArray(d?.data) ? d?.data?.[0] : d?.data
      if (r.ok && rec?.status === "ok") sent++
    } catch (_e) { /* best effort per device */ }
  }
  return sent
}

const DAY_SHORT: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
}
const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly",
  "1st_3rd": "1st & 3rd week", "2nd_4th": "2nd & 4th week",
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  try {
    if (!(await staffFromAuthHeader(req))) return json({ error: "Staff sign-in required." }, 401)
    const body = await req.json().catch(() => ({}))
    const propertyId = String(body.propertyId || "")
    if (!propertyId) return json({ error: "propertyId is required." }, 400)

    const p = (await sbGet(`properties?id=eq.${propertyId}&select=id,name,address,notes,pickup_days,pickup_frequency,pickup_start_date,created_at,customers(name)`))[0]
    if (!p) return json({ error: "Property not found." }, 404)
    if (!await notifEnabled("team_new_property")) return json({ ok: true, skipped: "toggle_off" })
    const customerName = p.customers?.name || "A client"

    const days = (p.pickup_days || []).map((d: string) => DAY_SHORT[d] || d).join(" & ") || "(days not set yet)"
    const freq = FREQ_LABEL[p.pickup_frequency] || p.pickup_frequency || "weekly"
    const whenEt = new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    const subject = `🏠 New property added — ${customerName}`
    const text = [
      `${customerName} has a new service address on the books.`,
      ``,
      `Address: ${p.address}`,
      `Schedule: ${days} (${freq.toLowerCase()})`,
      p.pickup_start_date ? `Starts: ${p.pickup_start_date}` : null,
      p.notes ? `Notes: ${p.notes}` : null,
      `Added: ${whenEt} (Eastern)`,
      ``,
      `It shows on the Routes board with a NEW badge for 30 days. Approve/assign it there if the day needs adjusting.`,
    ].filter((l) => l !== null).join("\n")
    const pushBody = `${customerName} — ${p.address} (${days}, ${freq.toLowerCase()})`

    let sms = 0, emailed = 0, pushed = 0
    sms = await textAdmins(`🏠 NEW PROPERTY: ${customerName} — ${p.address}. ${days}, ${freq.toLowerCase()}.${p.notes ? ` Notes: "${String(p.notes).slice(0, 120)}"` : ""} — Trashy Randy`)

    // Same recipient list + kill switch as the new_request_alerts automation.
    const autoRow = (await sbGet(`automations?kind=eq.new_request_alerts&select=status,config`).catch(() => []))[0]
    if (!autoRow || autoRow.status === "enabled") {
      const cfg = autoRow?.config || {}
      const emails = Array.isArray(cfg.emails) ? cfg.emails.map((e: unknown) => String(e).trim()).filter(Boolean) : []
      for (const to of emails) {
        try { await sendStaffAlertEmail(to, subject, text); emailed++ } catch (_e) { /* best effort per address */ }
      }
      if (cfg.push !== false) {
        try { pushed = await pushStaffDevices("🏠 New property added", pushBody) } catch (_e) { /* no tokens / Expo down */ }
      }
    }

    return json({ ok: true, sms, emailed, pushed })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
