// Notification preferences — the client-facing opt-out landing page (0052).
//
// The arrival/complete emails (and, later, texts) carry a footer link:
//   {SUPABASE_URL}/functions/v1/notify-prefs?token=<notify_optout_token>
// The token is a per-customer bearer capability (same model as the portal
// share token) — no login required. One tap:
//   - customers.notify_on_service = false  (the flag both notify fns honor)
//   - attaches the reserved "No Service Notifications" tag (staff/Randy see it)
// and the page confirms. Idempotent; repeat clicks just show the page again.
//
// Deploy with JWT verification OFF (public link):
//   supabase functions deploy notify-prefs --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const rest = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#f2f5f3;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#22302a;">
<div style="max-width:480px;margin:40px auto;background:#fff;border:1px solid #e2e8e4;border-radius:12px;overflow:hidden;">
<div style="background:#1f7a4d;color:#fff;padding:18px 22px;font-weight:700;font-size:16px;">Valet Waste FL</div>
<div style="padding:22px;font-size:15px;line-height:1.55;">${body}</div>
</div></body></html>`

Deno.serve(async (req) => {
  if (req.method !== "GET") {
    return new Response(PAGE("Notifications", "<p>Open the link from your email to manage notifications.</p>"),
      { status: 405, headers: { "Content-Type": "text/html; charset=utf-8" } })
  }
  try {
    const token = new URL(req.url).searchParams.get("token") || ""
    if (!token) {
      return new Response(PAGE("Notifications", "<p>That link isn't valid. Please use the link from your notification email.</p>"),
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?notify_optout_token=eq.${encodeURIComponent(token)}&select=id,name,contact_name`,
      { headers: rest },
    )
    const cust = (await r.json())[0]
    if (!cust) {
      return new Response(PAGE("Notifications", "<p>That link isn't valid anymore. Please use the link from your most recent notification email.</p>"),
        { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // Flag first (the mechanism both notify fns already honor)…
    await fetch(`${SUPABASE_URL}/rest/v1/customers?id=eq.${cust.id}`, {
      method: "PATCH", headers: rest, body: JSON.stringify({ notify_on_service: false }),
    })

    // …then the visibility tag (find-or-create, idempotent attach).
    const tags = await fetch(
      `${SUPABASE_URL}/rest/v1/tags?name=ilike.No%20Service%20Notifications&select=id&limit=1`,
      { headers: rest },
    )
    let tag = (await tags.json())[0]
    if (!tag) {
      tag = (await (await fetch(`${SUPABASE_URL}/rest/v1/tags`, {
        method: "POST",
        headers: { ...rest, Prefer: "return=representation" },
        body: JSON.stringify({ name: "No Service Notifications", color: "#8a6414" }),
      })).json())[0]
    }
    if (tag) {
      await fetch(`${SUPABASE_URL}/rest/v1/customer_tags`, {
        method: "POST",
        headers: { ...rest, Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({ customer_id: cust.id, tag_id: tag.id }),
      })
    }

    const who = (cust.contact_name || cust.name || "").trim()
    return new Response(
      PAGE(
        "You're off visit notifications",
        `<p><strong>You're all set${who ? `, ${who}` : ""}.</strong> You will no longer receive "we've arrived" or "service complete" notifications from Valet Waste FL.</p>
<p>This doesn't affect your service or billing — just the visit notifications.</p>
<p style="color:#7c8a82;font-size:13px;">Want them back? Just reply to any email from us or call the office and we'll turn them on again.</p>`,
      ),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  } catch (e) {
    return new Response(
      PAGE("Notifications", "<p>Something went wrong applying that link. Please try again or contact the office.</p>"),
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  }
})
