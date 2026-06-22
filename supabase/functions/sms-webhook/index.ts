// RingCentral inbound-SMS webhook.
//
// Three responsibilities:
//   1) Validation handshake — when RingCentral creates/renews the subscription
//      it POSTs with a "Validation-Token" header; we must echo it back in the
//      response header with 200 within ~3s.
//   2) Optional auth — if an admin saved a webhook verification token, require
//      a matching "Verification-Token" header on every notification.
//   3) Record inbound texts into sms_messages (direction 'in'), best-effort
//      matching the sender to a customer by phone.
//
// Deploy WITHOUT JWT verification (RingCentral calls it unauthenticated):
//   supabase functions deploy sms-webhook --no-verify-jwt
//
// Register this function's URL as the webhook/delivery address in your
// RingCentral subscription:  {SUPABASE_URL}/functions/v1/sms-webhook

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
}

async function getWebhookToken(): Promise<string | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/sms_secrets?id=eq.1&select=rc_webhook_verification_token`, { headers: restHeaders })
  const rows = await r.json()
  return rows[0]?.rc_webhook_verification_token || null
}

function digits(s: string): string {
  return (s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")
}

// Match an inbound sender to a customer by phone (last 10 digits).
async function findCustomerId(fromNumber: string): Promise<string | null> {
  const last10 = digits(fromNumber).slice(-10)
  if (last10.length < 10) return null
  // customers.phone may be stored in varied formats; match on the trailing 10.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/customers?select=id,phone&phone=like.*${last10.slice(-4)}*`,
    { headers: restHeaders },
  )
  if (!r.ok) return null
  const rows: Array<{ id: string; phone?: string }> = await r.json()
  const hit = rows.find((c) => digits(c.phone || "").slice(-10) === last10)
  return hit?.id || null
}

async function logInbound(row: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/sms_messages`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify(row),
  })
}

Deno.serve(async (req) => {
  // 1) Validation handshake (header is case-insensitive)
  const validation = req.headers.get("validation-token")
  if (validation) {
    return new Response("", { status: 200, headers: { "Validation-Token": validation } })
  }

  if (req.method !== "POST") return new Response("ok", { status: 200 })

  // 2) Optional verification token
  const expected = await getWebhookToken()
  if (expected) {
    const got = req.headers.get("verification-token")
    if (got !== expected) return new Response("forbidden", { status: 403 })
  }

  let payload: any = {}
  try { payload = await req.json() } catch (_e) { /* ignore */ }

  try {
    // RingCentral instant message-store notification: the message resource is
    // in body.body; SMS text is in `subject`. Parse defensively across shapes.
    const m = payload?.body?.body ?? payload?.body ?? payload
    const direction = (m?.direction || "").toLowerCase()
    // Only record inbound messages (ignore echoes of our own outbound).
    if (direction && direction !== "inbound") {
      return new Response("ignored", { status: 200 })
    }

    const fromNumber = m?.from?.phoneNumber || m?.from || ""
    const toNumber = Array.isArray(m?.to) ? (m.to[0]?.phoneNumber || m.to[0]) : (m?.to?.phoneNumber || m?.to || "")
    const text = m?.subject ?? m?.text ?? ""

    if (fromNumber) {
      const customerId = await findCustomerId(String(fromNumber))
      await logInbound({
        direction: "in",
        provider: "ringcentral",
        from_number: String(fromNumber),
        to_number: String(toNumber),
        body: String(text),
        status: "received",
        customer_id: customerId,
        external_id: m?.id ? String(m.id) : null,
        raw: payload,
      })
    } else {
      // Couldn't parse a sender — still store the raw payload for debugging.
      await logInbound({ direction: "in", provider: "ringcentral", status: "received", raw: payload })
    }
  } catch (e) {
    // Never 500 back to RingCentral (it would retry); record and move on.
    try { await logInbound({ direction: "in", provider: "ringcentral", status: "received", error: e instanceof Error ? e.message : String(e), raw: payload }) } catch (_e2) { /* */ }
  }

  return new Response("ok", { status: 200 })
})
