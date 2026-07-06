-- Portal v3: saved payment methods + autopay, client service requests, quotes.
-- Applied 2026-07-05.

-- 1) Saved card / autopay on the client record. The card itself lives in
--    Stripe (connected account); we keep only display metadata + consent.
alter table public.customers
  add column if not exists stripe_customer_id text,
  add column if not exists autopay_consent boolean not null default false,
  add column if not exists autopay_consented_at timestamptz,
  add column if not exists autopay_pm_id text,
  add column if not exists autopay_card_brand text,
  add column if not exists autopay_card_last4 text;

-- 2) Service requests submitted from the client portal.
create table if not exists public.portal_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null default 'other' check (kind in ('extra_pickup','junk_removal','lawn_care','billing','other')),
  property_ids uuid[] not null default '{}',
  message text,
  status text not null default 'new' check (status in ('new','seen','done')),
  created_at timestamptz default now()
);
create index if not exists portal_requests_customer_idx on public.portal_requests(customer_id);
alter table public.portal_requests enable row level security;
drop policy if exists staff_all_portal_requests on public.portal_requests;
create policy staff_all_portal_requests on public.portal_requests
  for all to authenticated using (is_staff()) with check (is_staff());

-- 3) Quotes / service agreements shown in the portal for approval.
create sequence if not exists quote_number_seq start 1001;
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  number text not null unique default ('Q-' || lpad(nextval('quote_number_seq')::text, 4, '0')),
  title text,
  notes text,
  -- [{description, quantity, unit_price, amount}]
  line_items jsonb not null default '[]'::jsonb,
  subtotal numeric not null default 0,
  total numeric not null default 0,
  status text not null default 'draft' check (status in ('draft','sent','approved','declined','void')),
  sent_at timestamptz,
  responded_at timestamptz,
  response_note text,
  created_by text,
  created_at timestamptz default now()
);
create index if not exists quotes_customer_idx on public.quotes(customer_id);
alter table public.quotes enable row level security;
drop policy if exists staff_all_quotes on public.quotes;
create policy staff_all_quotes on public.quotes
  for all to authenticated using (is_staff()) with check (is_staff());

-- 4) Monthly autopay automation (daily cron already calls automations-run;
--    the task itself only acts on the 1st, America/New_York).
insert into public.automations (kind, name, description, status, requested_by) values
 ('autopay_charge_monthly',
  'Autopay: charge saved cards on the 1st',
  'On the 1st of each month Randy charges each consenting client''s saved card for their open (sent) invoices from prior months, applies the 5th-pickup-week-free credit where the month had 5 pickup weeks, marks invoices paid, and texts admins the results.',
  'enabled',
  'David (portal v3, 2026-07-05)')
on conflict (kind) do nothing;
