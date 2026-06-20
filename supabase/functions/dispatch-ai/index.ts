// Trashy Randy — dispatch AI assistant (Supabase Edge Function).
//
// Holds the Anthropic API key server-side (never exposed to the browser) and
// runs an agentic tool-use loop. Right now it can create a client with a
// pickup schedule + invoice schedule directly in Supabase.
//
// Secrets required (set in Supabase, NOT in the frontend):
//   ANTHROPIC_API_KEY   - your Anthropic key
//   ANTHROPIC_MODEL     - optional, defaults to claude-sonnet-4-6
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6"
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const SYSTEM = `You are Trashy Randy, the dispatch assistant inside Valet Waste, a CRM for a waste-hauling business. You help set up clients, pickup schedules, and invoice schedules. Be concise and operational (1-3 sentences).

When the user asks to add or onboard a client, gather what you can from their message and call the create_client tool. Infer sensible defaults: weekly pickup on Monday and monthly invoicing unless they say otherwise. If the business name is missing, ask for it before creating. After creating, confirm what you set up in one short sentence.`

const tools = [
  {
    name: "create_client",
    description:
      "Create a new customer with a pickup schedule and an invoice schedule in the CRM.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Business / client name" },
        address: { type: "string" },
        contact_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        service: { type: "string", description: 'e.g. "4yd dumpster x2"' },
        pickup_frequency: {
          type: "string",
          enum: ["weekly", "biweekly", "monthly", "1st_3rd", "2nd_4th", "on_call"],
        },
        pickup_day: {
          type: "string",
          enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
        },
        invoice_cadence: {
          type: "string",
          enum: ["monthly", "per_service", "weekly", "quarterly", "annual"],
        },
        invoice_amount: { type: "number", description: "Recurring rate in dollars (optional)" },
        status: { type: "string", enum: ["active", "paused", "prospect"] },
      },
      required: ["name"],
    },
  },
]

async function sb(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`Supabase ${path}: ${r.status} ${await r.text()}`)
  return await r.json()
}

async function createClient(a: Record<string, unknown>) {
  const [customer] = await sb("customers", {
    name: a.name,
    address: a.address ?? null,
    contact_name: a.contact_name ?? null,
    email: a.email ?? null,
    phone: a.phone ?? null,
    status: a.status ?? "active",
  })
  await sb("pickup_schedules", {
    customer_id: customer.id,
    service: a.service ?? null,
    frequency: a.pickup_frequency ?? "weekly",
    day_of_week: a.pickup_frequency === "on_call" ? null : (a.pickup_day ?? "monday"),
  })
  await sb("invoice_schedules", {
    customer_id: customer.id,
    cadence: a.invoice_cadence ?? "monthly",
    amount: a.invoice_amount ?? null,
  })
  return { id: customer.id, name: customer.name }
}

async function callAnthropic(messages: unknown[], apiKey: string) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages }),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`)
  return data
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
    if (!apiKey) {
      return json({
        text: "I'm not connected yet — the ANTHROPIC_API_KEY secret hasn't been set in Supabase. Once it's added I can start creating clients.",
        created: [],
      })
    }

    const { messages: incoming } = await req.json()
    // Map the app's {role:'user'|'assistant', text} into Anthropic format.
    const messages: any[] = (incoming || [])
      .filter((m: any) => m && m.text)
      .map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }))

    const created: Array<{ id: string; name: string }> = []
    let finalText = ""

    for (let i = 0; i < 5; i++) {
      const res = await callAnthropic(messages, apiKey)
      finalText = (res.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim()

      if (res.stop_reason !== "tool_use") break

      messages.push({ role: "assistant", content: res.content })
      const results = []
      for (const block of res.content) {
        if (block.type !== "tool_use") continue
        try {
          if (block.name === "create_client") {
            const c = await createClient(block.input)
            created.push(c)
            results.push({ type: "tool_result", tool_use_id: block.id, content: `Created client "${c.name}" (id ${c.id}) with pickup + invoice schedules.` })
          } else {
            results.push({ type: "tool_result", tool_use_id: block.id, content: "Unknown tool.", is_error: true })
          }
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e instanceof Error ? e.message : String(e)}`, is_error: true })
        }
      }
      messages.push({ role: "user", content: results })
    }

    return json({ text: finalText || "Done.", created })
  } catch (e) {
    return json({ text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, created: [] }, 200)
  }
})
