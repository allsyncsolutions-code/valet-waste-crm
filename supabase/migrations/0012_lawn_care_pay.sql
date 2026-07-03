-- Lawn Care: per-job tech pay, photo-gated payment w/ admin override trail,
-- informational timesheets, weekly invoice line items. Applied 2026-07-02.
alter table public.properties add column if not exists tech_pay numeric;

alter table public.route_stops
  add column if not exists tech_pay numeric,
  add column if not exists pay_override boolean not null default false,
  add column if not exists pay_override_by text,
  add column if not exists pay_override_at timestamptz,
  add column if not exists nudge_sent boolean not null default false;

create table if not exists public.timesheets (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  work_date date not null,
  clock_in timestamptz,
  clock_out timestamptz,
  created_at timestamptz default now(),
  unique (profile_id, work_date)
);
alter table public.timesheets enable row level security;
drop policy if exists staff_all_timesheets on public.timesheets;
create policy staff_all_timesheets on public.timesheets
  for all to authenticated using (is_staff()) with check (is_staff());

alter table public.app_settings add column if not exists pay_cadence text not null default 'weekly';

insert into public.automations (kind, name, description, status, requested_by) values
 ('lawn_invoice_weekly_lines', 'Lawn: weekly invoice line items', 'Each morning, completed lawn stops from the previous day are added as line items ("Lawn care — address — week of …") on the client''s current-month draft invoice, so monthly invoices itemize each week''s cut.', 'enabled', 'David (Phase 3, 2026-07-02)')
on conflict (kind) do nothing;
