-- 0037: Allow status 'skipped' on route_stops.
-- 0025 added the skip feature (columns + app writes status='skipped') but never
-- loosened the status check constraint, so every skip UPDATE failed with
-- route_stops_status_check violation.

alter table public.route_stops
  drop constraint route_stops_status_check;

alter table public.route_stops
  add constraint route_stops_status_check
  check (status in ('pending','enroute','done','skipped'));
