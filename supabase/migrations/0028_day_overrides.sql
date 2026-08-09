-- 0028: One-time pickup-day changes (vs. permanent pickup_days edits).
-- A row means: on skip_date this property does NOT run its usual pickup, and
-- on service_date it runs instead (either side can be null for a pure skip or
-- a pure extra day). Route building + due lists consult this table, so a
-- one-time move survives a "Build from schedules" rebuild.
create table if not exists public.property_day_overrides (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  skip_date    date,           -- the regularly scheduled date being moved off of
  service_date date,           -- the one-time date it runs instead
  note         text,
  created_by   text,
  created_at   timestamptz not null default now(),
  check (skip_date is not null or service_date is not null)
);

create index if not exists idx_pdo_skip on public.property_day_overrides (skip_date);
create index if not exists idx_pdo_service on public.property_day_overrides (service_date);
create index if not exists idx_pdo_property on public.property_day_overrides (property_id);

alter table public.property_day_overrides enable row level security;
drop policy if exists staff_all_pdo on public.property_day_overrides;
create policy staff_all_pdo on public.property_day_overrides
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
