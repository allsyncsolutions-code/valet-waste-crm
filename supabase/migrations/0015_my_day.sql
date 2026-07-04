-- 0015: "On my way" timestamp for the lawn tech My Day view.
-- Techs tap "On My Way" before driving to a job; it texts the client and
-- stamps the stop so the button doesn't fire twice.
alter table public.route_stops add column if not exists on_my_way_at timestamptz;
