-- Morning cron for the automations runner — applied 2026-07-02
--
-- Same vault pattern as 0004: requires the project_url + service_role_key
-- vault secrets. Until those exist the tick silently no-ops.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.automations_run_tick()
returns void
language plpgsql
security definer
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/functions/v1/automations-run',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

-- 7:30am ET (11:30 UTC during EDT). One run per day.
select cron.schedule('automations-daily', '30 11 * * *', 'select public.automations_run_tick()')
where not exists (select 1 from cron.job where jobname = 'automations-daily');
