-- 0046: proactive Run Payments key keep-warm. The 1h api_key can only be
-- refreshed while still valid — once Run purges an expired key, the lazy
-- on-demand refresh can't authenticate and every payment path 401s until a
-- manual re-mint (outages 2026-08-20/25/26). This tick refreshes every 30
-- minutes so the stored key never dies. Same cron_token auth pattern as 0040.

create or replace function public.run_key_keepwarm_tick()
returns void
language plpgsql
security definer
as $$
declare
  v_token text;
begin
  select cron_token into v_token from public.internal_secrets where id = 1;
  if v_token is null then return; end if;
  perform net.http_post(
    url := 'https://ozoonpwuyusvksmydkuu.supabase.co/functions/v1/automations-run',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object('action', 'refresh_run_key')
  );
end;
$$;

select cron.schedule('run-key-keepwarm', '*/30 * * * *', 'select public.run_key_keepwarm_tick()')
where not exists (select 1 from cron.job where jobname = 'run-key-keepwarm');
