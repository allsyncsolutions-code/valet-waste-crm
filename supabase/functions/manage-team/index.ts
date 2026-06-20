// Team management — invite / change role / remove staff.
//
// Creating and deleting auth users requires the service-role key, which must
// never reach the browser, so it all runs here. The CALLER is authenticated
// from their JWT and must have profiles.role = 'admin'; otherwise rejected.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }

// REST helpers (service role — bypass RLS).
async function rest(path: string, opts: { method?: string; body?: unknown; prefer?: string } = {}) {
  const headers: Record<string, string> = { ...svc, "Content-Type": "application/json" }
  if (opts.prefer) headers["Prefer"] = opts.prefer
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  if (!r.ok) throw new Error((data && data.message) || `REST ${r.status}`)
  return data
}

// GoTrue admin (service role).
async function authAdmin(path: string, opts: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    method: opts.method || "POST",
    headers: { ...svc, "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  if (!r.ok) throw new Error((data && (data.msg || data.message || data.error_description)) || `Auth ${r.status}`)
  return data
}

function randomPassword() {
  // 16 url-safe chars — used when the admin doesn't supply one.
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 14) + "!7a"
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    // --- Authenticate the caller from their JWT and require admin role. -----
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    if (!token) return json({ error: "Not signed in." }, 401)
    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    })
    if (!ures.ok) return json({ error: "Invalid session." }, 401)
    const caller = await ures.json()
    const callerId = caller?.id
    if (!callerId) return json({ error: "Invalid session." }, 401)
    const rows = await rest(`profiles?id=eq.${callerId}&select=role`)
    if (!rows?.[0] || rows[0].role !== "admin") return json({ error: "Admins only." }, 403)

    const { action, email, full_name, role, password, id } = await req.json()

    if (action === "invite") {
      const cleanEmail = String(email || "").trim().toLowerCase()
      if (!cleanEmail) return json({ error: "Email is required." }, 400)
      const wantRole = role === "admin" ? "admin" : "staff"
      const pw = (password && String(password).length >= 8) ? String(password) : randomPassword()

      const created = await authAdmin("users", {
        body: { email: cleanEmail, password: pw, email_confirm: true, user_metadata: { full_name: full_name || null } },
      })
      const newId = created?.id
      if (!newId) return json({ error: "Could not create the user." }, 500)
      // Trigger created a pending profile; set the chosen role + name.
      await rest(`profiles?id=eq.${newId}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { role: wantRole, full_name: full_name || null },
      })
      return json({ ok: true, id: newId, email: cleanEmail, role: wantRole, password: pw })
    }

    if (action === "set_role") {
      const wantRole = ["admin", "staff", "pending"].includes(role) ? role : null
      if (!id || !wantRole) return json({ error: "Bad request." }, 400)
      if (id === callerId && wantRole !== "admin") return json({ error: "You can't remove your own admin access." }, 400)
      await rest(`profiles?id=eq.${id}`, { method: "PATCH", prefer: "return=minimal", body: { role: wantRole } })
      return json({ ok: true })
    }

    if (action === "remove") {
      if (!id) return json({ error: "Bad request." }, 400)
      if (id === callerId) return json({ error: "You can't remove yourself." }, 400)
      await authAdmin(`users/${id}`, { method: "DELETE" })
      return json({ ok: true })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
