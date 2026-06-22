# Valet Waste — SMS triggers (from the old Replit api-server)

Traced from `artifacts/api-server/src` on 2026-06-21. This is the full list of
places the old app sends a text, so we can wire the same into the new
Supabase/Vercel build. Everything routes through one service.

## Central service — `lib/smsService.ts`

`sendSms(opts)` where `opts = { to, body, purpose?, customerId?, jobId?, invoiceId?, sentByName? }`.

- Normalizes the number to E.164 (`normalizePhone`).
- Picks the provider: **RingCentral if configured & enabled, else Telnyx** (and falls back to Telnyx if a RingCentral send throws). This is exactly the logic already ported into the new `sms` edge function.
- Logs every attempt to `sms_messages` with `purpose`, `customer_id`, and `sent_by` — note the old log table also stores **purpose / jobId / invoiceId / sentByName**, which the new `sms_messages` table doesn't have yet (worth adding for the Activity view).
- Telnyx creds in the old app live in **settings** (`smsApiKey`, `smsFromNumber`, `smsEnabled`), not env vars — the new version currently expects `TELNYX_API_KEY` / `TELNYX_FROM` as function secrets. Decide which you prefer.

## The triggers

| # | Event | File:line | purpose | Recipient |
|---|-------|-----------|---------|-----------|
| 1 | **Verification code** (portal login / payment) | `routes/portal-payments.ts:57` | manual | customer |
| 2 | **New service request → alert admins** | `routes/portal.ts:496` | (admin) | every admin's phone + employee push |
| 3 | **Manual message** (admin texts a customer) | `routes/messages.ts:184,196` | manual | customer |
| 4 | **Check-in** (tech arriving) | `routes/jobs.ts:185` | checkin | customer |
| 5 | **Check-out** (service complete) | `routes/jobs.ts:410` | checkout | customer |
| 6 | **Service reminder** | `routes/jobs.ts:301` | reminder | customer |
| 7 | **Invoice send** | `routes/invoices.ts:587` | invoice | customer |
| 8 | Test message | `routes/settings.ts:54` | test | self |

## Message templates (editable, stored in settings)

Each customer-facing message is a template string with `{token}` placeholders,
saved on the settings row, with an inline default and an optional per-send
`customMessage` override:

- `settings.checkinMessageTemplate` — default: *"Hi {customerName}, your Valet Waste FL technician is arriving at your property now for your {serviceType} service. Thank you for choosing us!"*
- `settings.checkoutMessageTemplate` — default: *"Hi {customerName}, your {serviceType} service at {address} is complete. Thank you for choosing {companyName}!"*
- `settings.reminderMessageTemplate` — `customMessage || template || default`
- `settings.invoiceMessageTemplate` — `customMessage || template || default`

**Placeholder tokens in use:** `{customerName}` (→ first + last), `{serviceType}`, `{address}`, `{companyName}` (→ settings.companyName, default "Valet Waste FL"), `{invoiceNumber}`, `{total}` (→ `Number(total).toFixed(2)`), `{payLink}`.

Service-request alert (#2) is **not** a template — it's a built string:
`"New service request from {first} {last} ({phone|"no phone"}): {serviceType} at {address} - {description} (Job #{id})"` plus an optional `| Properties: …` suffix, sent to each admin and also pushed to employees (`sendPushToEmployees(["admin"], …)`).

## To replicate in the new app

1. Add template columns to `app_settings` (`sms_checkin_template`, `sms_checkout_template`, `sms_reminder_template`, `sms_invoice_template`) + a small "Message templates" UI in the SMS settings card.
2. Add `purpose` / `customer_id` / `sent_by` columns to `sms_messages` (customer_id already exists; add `purpose`, `sent_by`).
3. A `renderTemplate(tpl, vars)` helper that swaps the `{tokens}`.
4. Hook each trigger into the new app's flows (check-in/out + reminder live in the Schedule/Routes views; invoice send in Invoices; service request in the Portal; manual send in a Messages view that doesn't exist yet in the new app).

Triggers 4–6 depend on the new app's check-in / scheduling flow, and #2/#3 depend on a portal + messages surface that the new build may not have yet — so these should be prioritized against what's already live.
