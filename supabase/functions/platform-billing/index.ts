// Platform (SaaS) billing — the CRM charging the Valet Waste business $250/mo.
//
// This is a DIFFERENT money flow from the `stripe` function:
//   • `stripe`            → Stripe Connect; the business charges ITS customers.
//   • `platform-billing`  → the AllSync CRM account charges the business itself.
//
// Secrets (set in Supabase → Edge Functions → Secrets):
//   STRIPE_PLATFORM_SECRET_KEY      (required)  sk_live_… / sk_test_…
//   STRIPE_PLATFORM_WEBHOOK_SECRET  (required for webhook)  whsec_…
//   STRIPE_PLATFORM_PRICE_ID        (optional)  defaults to the $250/mo price
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Actions (POST JSON { action }):
//   status   — current subscription snapshot            (staff only)
//   checkout — hosted Checkout URL to start/attach card (staff only)
//   portal   — hosted Billing Portal URL to manage card (staff only)
// Stripe webhooks POST here with a `stripe-signature` header (no JWT).
//
// Deploy WITHOUT JWT verification (Stripe calls the webhook unauthenticated);
// the admin actions authenticate the caller's JWT manually below.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const PRICE_ID = Deno.env.get("STRIPE_PLATFORM_PRICE_ID") || "price_1TofO4F2qLCLnibvAY4znEH6"
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }

// ---- Stripe REST (form-encoded, like the `stripe` function) ---------------
function form(obj: Record<string, unknown>) {
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
async function stripeApi(path: string, sk: string, opts: { method?: string; body?: Record<string, unknown> } = {}) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: opts.method || "POST",
    headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: opts.body ? form(opts.body) : undefined,
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error?.message || `Stripe ${r.status}`)
  return d
}

// ---- platform_billing row (single row, id = 1) ----------------------------
async function getBilling(): Promise<Record<string, any>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/platform_billing?id=eq.1&select=*`, { headers: svc })
  const rows = await r.json()
  return rows[0] || {}
}
async function patchBilling(patch: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/platform_billing?id=eq.1`, {
    method: "PATCH",
    headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  })
}
const iso = (unix?: number | null) => (unix ? new Date(unix * 1000).toISOString() : null)

// Snapshot a Stripe subscription object into our row shape.
function subPatch(sub: any) {
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    status: sub.status,
    price_id: sub.items?.data?.[0]?.price?.id || PRICE_ID,
    current_period_end: iso(sub.current_period_end),
    cancel_at_period_end: !!sub.cancel_at_period_end,
  }
}

// ---- Authenticate an admin action from the caller's Supabase JWT ----------
async function requireStaff(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
  if (!token) return null
  const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!ures.ok) return null
  const caller = await ures.json()
  const callerId = caller?.id
  if (!callerId) return null
  // Must be staff — mirrors is_staff(): role in ('admin','staff').
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${callerId}&select=role`, { headers: svc })
  const rows = await r.json()
  const role = rows?.[0]?.role
  if (role !== "admin" && role !== "staff") return null
  return callerId
}

// ---- Stripe webhook signature verification (Web Crypto HMAC-SHA256) --------
async function verifyStripeSig(payload: string, sigHeader: string, secret: string, toleranceSec = 300): Promise<boolean> {
  const parts: Record<string, string> = {}
  for (const kv of sigHeader.split(",")) {
    const i = kv.indexOf("=")
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  }
  const t = parts["t"], v1 = parts["v1"]
  if (!t || !v1) return false
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")
  if (hex.length !== v1.length) return false
  let diff = 0
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i)
  if (diff !== 0) return false
  const age = Math.floor(Date.now() / 1000) - Number(t)
  return Number.isFinite(age) && Math.abs(age) <= toleranceSec
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  const sk = Deno.env.get("STRIPE_PLATFORM_SECRET_KEY")
  if (!sk) return json({ error: "Platform billing isn't configured yet — set STRIPE_PLATFORM_SECRET_KEY in Supabase." })

  // ===== Webhook path (Stripe → us, unauthenticated but signed) ============
  const sig = req.headers.get("stripe-signature")
  if (sig) {
    const whsec = Deno.env.get("STRIPE_PLATFORM_WEBHOOK_SECRET")
    const raw = await req.text()
    if (!whsec) return json({ error: "Webhook secret not set." }, 400)
    if (!(await verifyStripeSig(raw, sig, whsec))) return json({ error: "Bad signature." }, 400)
    let event: any
    try { event = JSON.parse(raw) } catch { return json({ error: "Bad payload." }, 400) }
    try {
      const obj = event.data?.object || {}
      switch (event.type) {
        case "checkout.session.completed": {
          const patch: Record<string, unknown> = {}
          if (obj.customer) patch.stripe_customer_id = obj.customer
          if (obj.subscription) {
            const sub = await stripeApi(`subscriptions/${obj.subscription}`, sk, { method: "GET" })
            Object.assign(patch, subPatch(sub))
          }
          if (Object.keys(patch).length) await patchBilling(patch)
          break
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          await patchBilling(subPatch(obj))
          break
        }
        case "invoice.paid":
          await patchBilling({ status: "active", current_period_end: iso(obj.lines?.data?.[0]?.period?.end || obj.period_end) })
          break
        case "invoice.payment_failed":
          await patchBilling({ status: "past_due" })
          break
      }
    } catch (e) {
      console.error("platform-billing webhook error", e)
      // Still 200 so Stripe doesn't hammer retries on a transient write error.
    }
    return json({ received: true })
  }

  // ===== Admin actions (our frontend → us, JWT-gated) ======================
  try {
    const body = await req.json().catch(() => ({}))
    const action = body.action
    const origin = body.origin || ""

    const callerId = await requireStaff(req)
    if (!callerId) return json({ error: "Not authorized." }, 401)

    const billing = await getBilling()
    let customerId: string | undefined = billing.stripe_customer_id || undefined

    if (action === "status") {
      return json({
        status: billing.status || "none",
        hasCustomer: !!customerId,
        hasSubscription: !!billing.stripe_subscription_id,
        currentPeriodEnd: billing.current_period_end || null,
        cancelAtPeriodEnd: !!billing.cancel_at_period_end,
        priceId: billing.price_id || PRICE_ID,
      })
    }

    if (action === "checkout") {
      // Reuse the customer if we have one; otherwise let Checkout create it and
      // we capture the id on checkout.session.completed. Pre-create so the
      // Billing Portal works even before the first invoice settles.
      if (!customerId) {
        const cust = await stripeApi("customers", sk, { body: { name: "Valet Waste", metadata: { app: "valet-waste-crm" } } })
        customerId = cust.id
        await patchBilling({ stripe_customer_id: customerId })
      }
      const session = await stripeApi("checkout/sessions", sk, {
        body: {
          mode: "subscription",
          customer: customerId,
          line_items: [{ price: PRICE_ID, quantity: 1 }],
          success_url: `${origin}/?crm_billing=success`,
          cancel_url: `${origin}/?crm_billing=cancel`,
          allow_promotion_codes: true,
        },
      })
      return json({ url: session.url })
    }

    if (action === "portal") {
      if (!customerId) return json({ error: "No billing set up yet — start the subscription first." })
      const session = await stripeApi("billing_portal/sessions", sk, {
        body: { customer: customerId, return_url: `${origin}/?crm_billing=portal` },
      })
      return json({ url: session.url })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) })
  }
})
