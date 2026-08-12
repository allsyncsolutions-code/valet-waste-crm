// Run Merchant webhook receiver — marks invoices paid when a transaction
// settles. Closes the gap left by the old Stripe Flow A (which had no webhook
// and relied on staff manually clicking "Mark paid").
//
// Run Payments POSTs signed events here. Verify with the shared HMAC secret
// (X-Webhook-Signature-256: sha256=<hex>), dedupe on X-Idempotency-Key /
// metadata.webhook_id (Run retries up to 8 times over ~27h), and apply the
// event. Always return 200 so Run doesn't keep retrying.
//
// Register this URL with your Run Payments Integration Delivery Lead; they'll
// configure the endpoint and give you the signing secret (store it as the
// run_webhook_secret in app_settings, or set RUN_WEBHOOK_SECRET below).
//
// Deploy with --no-verify-jwt (Run calls this unauthenticated, but signed).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const restHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders })
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`)
  return await r.json()
}
async function sbPatch(path: string, body: unknown) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: restHeaders, body: JSON.stringify(body) })
}
async function sbInsert(path: string, body: unknown) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...restHeaders, "Prefer": "return=representation" },
    body: JSON.stringify(body),
  })
}

async function verifySig(raw: string, sigHeader: string, secret: string): Promise<boolean> {
  // Header format: "sha256=<hex>"
  const expected = sigHeader.replace(/^sha256=/i, "").trim()
  if (!expected) return false
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")
  if (hex.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } })
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })

  const raw = await req.text()
  let event: any
  try { event = JSON.parse(raw) } catch { return ok() } // swallow bad payloads

  // Signature check. Secret may be in app_settings or an env var.
  const sig = req.headers.get("X-Webhook-Signature-256") || req.headers.get("x-webhook-signature-256") || ""
  let secret = Deno.env.get("RUN_WEBHOOK_SECRET")
  if (!secret) {
    const s = (await sbGet(`app_settings?id=eq.1&select=run_webhook_secret`))[0] || {}
    secret = s.run_webhook_secret
  }
  if (secret) {
    if (!sig || !(await verifySig(raw, sig, secret))) return ok() // reject silently (200 to stop retries)
  }

  // Idempotency: dedupe on webhook_id (PK insert no-op on conflict).
  const webhookId = event?.metadata?.webhook_id || req.headers.get("X-Idempotency-Key") || event?.metadata?.idempotency_key || crypto.randomUUID()
  try {
    await sbInsert("run_webhook_events", {
      webhook_id: webhookId,
      event_type: event?.event_type || "unknown",
      trans_id: event?.payload?.trans_id || event?.trans_id || null,
      payload: JSON.parse(raw),
    })
  } catch (_e) {
    // PK conflict = already processed.
    return ok()
  }

  try {
    const type = event?.event_type || ""
    const p = event?.payload || {}
    const transId = p.trans_id || event?.trans_id
    // Run Merchant echoes back our invoice_id (we set it on the charge).
    const invoiceId = p.invoice_id || p.order_id || p.metadata?.invoice_id
    const result = p.result

    // Approvals can arrive as transaction.entered with result A, or as a
    // dedicated approval event. Declines/refunds update accordingly.
    if (type === "transaction.entered" && result === "A" && invoiceId) {
      const inv = (await sbGet(`invoices?id=eq.${invoiceId}&select=id,status`))[0]
      if (inv && inv.status !== "paid") {
        await sbPatch(`invoices?id=eq.${invoiceId}`, {
          status: "paid",
          paid_at: new Date().toISOString(),
          run_paid_at: new Date().toISOString(),
          run_trans_id: String(transId || ""),
        })
      }
    } else if (type === "transaction.decline" && invoiceId) {
      // Declines don't change invoice status (it stays 'sent' for retry/manual),
      // but we record the transaction id for support. Randy texts admins below.
    } else if ((type === "transaction.refund" || type === "transaction.partialrefund") && invoiceId) {
      // A full refund reopens the invoice; partial refunds leave it paid.
      if (type === "transaction.refund") {
        await sbPatch(`invoices?id=eq.${invoiceId}`, { status: "sent", paid_at: null })
      }
    }
  } catch (_e) {
    // Swallow — we still return 200 so Run stops retrying. Errors here are
    // recoverable via the Reporting API / manual review.
  }

  return ok()
})
