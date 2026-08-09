// Staff "Forgot password?" — public reset-by-email-code for employee logins.
//
// Why a typed code instead of a recovery link: the mobile app already hit the
// magic-link-opens-Safari problem (that's why the client portal uses codes),
// and a 6-digit code works identically in the web CRM and the native app.
//
// Actions (POST JSON { action, ... }):
//   request_code {email}              → emails a 6-digit code (10-min, one-time).
//                                       ALWAYS replies generically so this can't be
//                                       used to probe which emails are staff accounts.
//   reset {email, code, new_password} → verifies the code, sets the password via the
//                                       GoTrue admin API, marks the code used.
//
// Deployed with verify_jwt=false (the caller is signed out by definition) —
// identity is proven by control of the staff email inbox, mirroring the client
// portal's request_code/redeem_code flow.
// Secrets: SENDGRID_API_KEY (required), SENDGRID_FROM (optional).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const SENDGRID_FROM = Deno.env.get("SENDGRID_FROM") || "valetwastefl@allsynccrm.com"

// Accounts whose password must NEVER change through self-serve reset.
// appreview's password is declared to Google Play — silent drift there caused
// the July credentials rejections.
const PROTECTED = new Set(["appreview@allsynccrm.com"])

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
async function sbPost(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`)
}
async function sbPatch(path: string, body: unknown) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function sendEmail(to: string, subject: string, html: string, companyName: string) {
  const key = Deno.env.get("SENDGRID_API_KEY")
  if (!key) throw new Error("SENDGRID_API_KEY is not configured.")
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: SENDGRID_FROM, name: companyName },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  })
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${await r.text()}`)
}

function codeHtml(name: string | null, code: string, companyName: string) {
  return `<p>Hi ${name || "there"},</p>
<p>Your ${companyName} password reset code:</p>
<p style="font-size:34px;font-weight:800;letter-spacing:6px;margin:14px 0">${code}</p>
<p style="color:#777;font-size:13px">Enter it on the sign-in screen along with your new password. The code works once and expires in 10 minutes.</p>
<p style="color:#777;font-size:13px">Didn't request this? You can ignore this email — your password hasn't changed.</p>`
}

async function companyName(): Promise<string> {
  try {
    const s = (await sbGet(`app_settings?id=eq.1&select=company_name`))[0]
    return s?.company_name || "Valet Waste FL"
  } catch (_e) {
    return "Valet Waste FL"
  }
}

// A staff account = a profiles row with role admin/staff (pending is excluded).
async function staffByEmail(email: string) {
  const enc = encodeURIComponent
  const rows = await sbGet(`profiles?email=ilike.${enc(email)}&select=id,email,full_name,role&limit=2`)
  const p = rows[0]
  if (!p || !["admin", "staff"].includes(p.role)) return null
  return p
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const { action, email, code, new_password } = await req.json()
    const clean = String(email || "").trim().toLowerCase()

    if (action === "request_code") {
      // Same reply for every outcome — never reveals whether the email is staff.
      const generic = { ok: true, message: "If that email belongs to a staff account, a reset code is on its way." }
      if (!clean) return json({ error: "Enter your work email." }, 400)
      if (PROTECTED.has(clean)) return json(generic)
      const staff = await staffByEmail(clean)
      if (!staff) return json(generic)

      // Throttle: at most 5 codes per account per hour.
      const hourAgo = new Date(Date.now() - 3600000).toISOString()
      const recent = await sbGet(`staff_reset_codes?user_id=eq.${staff.id}&created_at=gte.${hourAgo}&select=id`)
      if ((recent || []).length >= 5) return json(generic)

      const digits = String(Math.floor(100000 + Math.random() * 900000))
      await sbPost("staff_reset_codes", {
        user_id: staff.id,
        code_hash: await sha256(`${clean}:${digits}`),
        expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
      })
      const company = await companyName()
      await sendEmail(clean, `${digits} is your ${company} password reset code`, codeHtml(staff.full_name, digits, company), company)
      return json(generic)
    }

    if (action === "reset") {
      if (!clean || !code) return json({ error: "Enter the code from your email." }, 400)
      const pw = String(new_password || "")
      if (pw.length < 8) return json({ error: "Pick a password with at least 8 characters." }, 400)
      if (PROTECTED.has(clean)) return json({ error: "This account's password can't be reset here." }, 403)
      const staff = await staffByEmail(clean)
      if (!staff) return json({ error: "That code is wrong or expired — request a new one." }, 401)

      const hash = await sha256(`${clean}:${String(code).trim()}`)
      const rows = await sbGet(
        `staff_reset_codes?user_id=eq.${staff.id}&code_hash=eq.${hash}&used_at=is.null&select=id,expires_at&order=created_at.desc&limit=1`,
      )
      const rc = rows[0]
      if (!rc || new Date(rc.expires_at).getTime() < Date.now()) {
        return json({ error: "That code is wrong or expired — request a new one." }, 401)
      }

      // Burn the code BEFORE changing the password so it can never be replayed.
      await sbPatch(`staff_reset_codes?id=eq.${rc.id}`, { used_at: new Date().toISOString() })

      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${staff.id}`, {
        method: "PUT",
        headers: { ...restHeaders },
        body: JSON.stringify({ password: pw }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d?.msg || d?.message || `Could not update the password (${r.status}).`)
      }
      return json({ ok: true, message: "Password updated — you can sign in now." })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
