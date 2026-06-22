-- SMS message templates + richer message log — applied 2026-06-21
--
-- The old app stored editable per-event message templates on its settings row
-- (with {token} placeholders) and logged each text with a purpose + sender.
-- Port both: template columns on app_settings, and purpose/sent_by on the log.

-- Editable templates (defaults mirror the old app's copy) -------------------
alter table public.app_settings
  add column if not exists company_name text,
  add column if not exists sms_checkin_template  text default 'Hi {customerName}, your Valet Waste FL technician is arriving at your property now for your {serviceType} service. Thank you for choosing us!',
  add column if not exists sms_checkout_template text default 'Hi {customerName}, your {serviceType} service at {address} is complete. Thank you for choosing {companyName}!',
  add column if not exists sms_reminder_template text default 'Hi {customerName}, this is a reminder about your upcoming {serviceType} service at {address}. — {companyName}',
  add column if not exists sms_invoice_template  text default 'Hi {customerName}, invoice {invoiceNumber} for {total} is ready. Pay here: {payLink} — {companyName}';

-- Richer message log (why it was sent + who sent it) ------------------------
alter table public.sms_messages
  add column if not exists purpose text,   -- invoice | reminder | checkin | checkout | manual | test | reply
  add column if not exists sent_by text;   -- staff name for manual sends
