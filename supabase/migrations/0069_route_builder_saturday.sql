-- 0069: Route builder runs Saturdays at 8pm ET (not in the daily suite).
--
-- The auto_build_week_routes automation moves from the daily 7:30am pass to
-- its own weekly trigger: Saturday 8pm America/New_York, DST-proof. pg_cron
-- on this project has no timezone-aware cron.schedule, so the job fires in
-- the 00:00–01:00 UTC Sunday window (covers 8pm Eastern under both DST
-- offsets) and the tick itself only proceeds during the 8pm hour in
-- America/New_York — exactly one of the two hourly firings passes the guard,
-- in summer and winter alike.
--
-- The automation row gets config.weekly_only, which automations-run respects:
-- the daily suite skips it; only this trigger (or the tab's "Run now") runs it.
--
-- STAGED ONLY — apply with owner approval (AGENTS.md).

create or replace function public.auto_build_routes_tick()
returns void
language plpgsql
security definer
as $$
declare
  v_token text;
  v_hour int;
begin
  select cron_token into v_token from public.internal_secrets where id = 1;
  if v_token is null then return; end if;
  -- Only fire during the 8pm hour Eastern (the cron covers both the EDT and
  -- EST UTC offsets; the guard picks the right one year-round).
  select extract(hour from now() at time zone 'America/New_York')::int into v_hour;
  if v_hour <> 20 then return; end if;
  perform net.http_post(
    url := 'https://ozoonpwuyusvksmydkuu.supabase.co/functions/v1/automations-run?kind=auto_build_week_routes',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

-- Hourly through the Sunday 00:00–01:00 UTC window = Saturday 8pm ET exactly
-- once, regardless of daylight saving.
select cron.schedule('auto-build-routes-saturday', '0 0-1 * * 0', 'select public.auto_build_routes_tick()');

update public.automations
   set config = coalesce(config, '{}'::jsonb) || '{"weekly_only": true}'::jsonb,
       name = 'Auto-build next week''s routes (Saturdays 8pm ET)',
       description = 'Every Saturday at 8pm ET, next week''s routes are pulled in automatically from the previous week — every stop carried over to the same weekday (paused clients and skip-days respected). Routes that already exist are never touched, so anything built or edited by hand always wins. Randy texts the team a summary.'
 where kind = 'auto_build_week_routes';
