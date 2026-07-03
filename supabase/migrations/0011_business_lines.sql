-- Business lines become real: waste | junk | lawn. Applied 2026-07-02.
-- Existing data is all Waste & Recycling.
alter table public.customers      add column if not exists business_line text not null default 'waste';
alter table public.properties     add column if not exists business_line text not null default 'waste';
alter table public.routes         add column if not exists business_line text not null default 'waste';
alter table public.route_defaults add column if not exists business_line text not null default 'waste';

-- Per-staff line access. Everyone existing (incl. all admins) gets all lines;
-- restrict per-member from the Team tab.
alter table public.profiles
  add column if not exists business_lines text[] not null default array['waste','junk','lawn'];

-- One-time jobs (Junk Removal now): calendar-scheduled, not routed.
-- route_stop_id links a job that got slotted into a live route mid-day.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  business_line text not null default 'junk',
  customer_id uuid references public.customers(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  address text,
  scheduled_date date not null,
  time_window text,
  status text not null default 'scheduled' check (status in ('scheduled','done','canceled')),
  amount numeric,
  driver_id uuid references public.profiles(id) on delete set null,
  notes text,
  route_stop_id uuid references public.route_stops(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists jobs_date_idx on public.jobs(scheduled_date);
create index if not exists jobs_line_idx on public.jobs(business_line);
alter table public.jobs enable row level security;
drop policy if exists staff_all_jobs on public.jobs;
create policy staff_all_jobs on public.jobs
  for all to authenticated using (is_staff()) with check (is_staff());
