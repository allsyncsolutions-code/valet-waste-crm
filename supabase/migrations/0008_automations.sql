-- Automations catalog: things Trashy Randy runs on a schedule or has
-- suggested — reviewed/approved on the CRM's Automations tab. Applied 2026-07-02.
create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  kind text not null unique,
  name text not null,
  description text,
  status text not null default 'suggested' check (status in ('suggested','enabled','paused')),
  config jsonb not null default '{}'::jsonb,
  requested_by text,
  last_run_at timestamptz,
  last_result text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.automations enable row level security;
drop policy if exists staff_all_automations on public.automations;
create policy staff_all_automations on public.automations
  for all to authenticated using (is_staff()) with check (is_staff());

insert into public.automations (kind, name, description, status, requested_by) values
 ('outstanding_digest', 'Daily outstanding-balance text', 'Every morning Randy texts staff a list of unpaid invoices — client, amount, days overdue, last contact — and anyone can reply to have him send a payment-link nudge.', 'enabled', 'Valet Waste team (via SMS, 2026-07-02)'),
 ('auto_invoice_reminders', 'Auto-remind overdue invoices', 'Randy texts clients payment reminders on overdue invoices automatically and notifies staff of what went out. Approve on this tab to activate.', 'suggested', 'Valet Waste team (via SMS, 2026-07-02)')
on conflict (kind) do nothing;
