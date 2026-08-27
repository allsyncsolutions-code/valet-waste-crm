-- 0047 — invoice reminder automation (2026-08-27)
-- Up to 5 configurable reminders per open invoice: trigger (days after sent /
-- before due / after due), per-channel delivery (sms/email/push), and a
-- freeform template with [customer name] / [invoice link] / etc. fields.
-- Config lives on the automations row (kind 'auto_invoice_reminders').config;
-- this table is the once-per-reminder-per-invoice dedupe record.

create table if not exists invoice_reminder_sends (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  reminder_key text not null,
  channels text,
  detail text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (invoice_id, reminder_key)
);
alter table invoice_reminder_sends enable row level security;

-- Customer-keyed push tokens: client-app users register against their
-- customer row (staff tokens keep using profile_id). Nullable on purpose —
-- existing rows are all staff. Reminders read tokens by customer_id.
alter table push_tokens add column if not exists customer_id uuid references customers(id) on delete cascade;
create index if not exists push_tokens_customer_idx on push_tokens(customer_id);
