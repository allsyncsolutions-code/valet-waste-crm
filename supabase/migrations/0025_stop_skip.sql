-- 0025: Skip a stop (flag + note) instead of deleting it.
-- A skipped stop stays on the route with status 'skipped' plus who/why/when,
-- so dispatch and drivers can see it was intentionally passed over.
alter table public.route_stops
  add column if not exists skip_reason text,
  add column if not exists skipped_by  text,
  add column if not exists skipped_at  timestamptz;

comment on column public.route_stops.skip_reason is 'Why the stop was skipped (set when status = skipped)';
