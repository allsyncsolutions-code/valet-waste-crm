// Stripe Connect (Standard accounts) — onboarding, status, and payment links.
//
// Single-tenant: one connected account, stored on app_settings.stripe_account_id.
// The platform's secret key lives server-side only.
//   Secret required: STRIPE_SECRET_KEY  (your platform's TEST then LIVE key)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// verify_jwt is disabled (frontend uses the publishable key, not a JWT).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// Encode (possibly nested) params the way the Stripe API expects.
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

async function stripeApi(path: string, sk: string, opts: { method?: string; body?: Record<string, unknown>; account?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sk}`,
    "Content-Type": "application/x-www-form-urlencoded",
  }
  if (opts.account) headers["Stripe-Account"] = opts.account
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: opts.method || "POST",
    headers,
    body: opts.body ? form(opts.body) : undefined,
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error?.message || `Stripe ${r.status}`)
  return d
}

async function getSettings() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=*`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const rows = await r.json()
  return rows[0] || {}
}
async function setAccountId(id: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/app_settings?id=eq.1`, {
    method: "PATCH",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ stripe_account_id: id }),
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  const sk = Deno.env.get("STRIPE_SECRET_KEY")
  if (!sk) return json({ error: "Stripe isn't configured yet — set the STRIPE_SECRET_KEY secret in Supabase." })

  try {
    const { action, origin, amount, description, customerName } = await req.json()
    const settings = await getSettings()
    let accountId: string | undefined = settings.stripe_account_id || undefined

    if (action === "status") {
      if (!accountId) return json({ connected: false })
      const acct = await stripeApi(`accounts/${accountId}`, sk, { method: "GET" })
      return json({
        connected: true,
        accountId,
        chargesEnabled: !!acct.charges_enabled,
        detailsSubmitted: !!acct.details_submitted,
        payoutsEnabled: !!acct.payouts_enabled,
      })
    }

    if (action === "onboard") {
      if (!accountId) {
        const acct = await stripeApi("accounts", sk, { body: { type: "standard" } })
        accountId = acct.id
        await setAccountId(accountId!)
      }
      const base = origin || ""
      const link = await stripeApi("account_links", sk, {
        body: {
          account: accountId,
          refresh_url: `${base}/?stripe=refresh`,
          return_url: `${base}/?stripe=return`,
          type: "account_onboarding",
        },
      })
      return json({ url: link.url })
    }

    if (action === "payment_link") {
      if (!accountId) return json({ error: "Connect a Stripe account first." })
      const cents = Math.round(Number(amount) * 100)
      if (!cents || cents < 50) return json({ error: "Enter an amount of at least $0.50." })
      const session = await stripeApi("checkout/sessions", sk, {
        account: accountId,
        body: {
          mode: "payment",
          success_url: `${origin || ""}/?paid=1`,
          cancel_url: `${origin || ""}/?paid=0`,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: cents,
                product_data: { name: description || `Payment${customerName ? " — " + customerName : ""}` },
              },
            },
          ],
        },
      })
      return json({ url: session.url })
    }

    return json({ error: "Unknown action." }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) })
  }
})
