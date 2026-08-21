-- Day-scoped route combinations: when one driver (or two riding together) has
-- to run two routes, the dispatch board shows them as ONE combined run for
-- that date only. The underlying routes/stops are untouched, so splitting the
-- combo (or the next day) brings the normal routes straight back.
create table if not exists public.route_combos (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  codes text[] not null,                       -- e.g. {A,B}; order = run order
  driver_ids uuid[] not null default '{}',     -- who is running the combined run (1 or 2 drivers)
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists route_combos_date_idx on public.route_combos (service_date);

alter table public.route_combos enable row level security;
drop policy if exists staff_all_route_combos on public.route_combos;
create policy staff_all_route_combos on public.route_combos
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

do $$ begin
  alter publication supabase_realtime add table public.route_combos;
exception when duplicate_object then null; end $$;
