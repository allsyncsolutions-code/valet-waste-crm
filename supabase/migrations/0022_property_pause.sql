-- Pause an individual service address without deleting it.
--
-- A paused property keeps all of its history (visits, photos, invoices) but is
-- skipped everywhere the app enumerates addresses that are "due for service":
--   * route auto-populate / "build from schedules"  (loadActiveSchedules)
--   * the unrouted / due-today list                  (loadRouteSlice)
--   * the mass add-to-route picker                   (loadAllProperties)
--   * the Dashboard "today's pickups" count          (loadPropertyPickups)
-- Resume simply flips the flag back to false.
alter table public.properties
  add column if not exists paused boolean not null default false;

-- Partial index: only paused rows are indexed (the common case is not-paused),
-- so route builders that filter `paused = false` stay fast on large tables.
create index if not exists properties_paused_idx
  on public.properties (paused) where paused;
