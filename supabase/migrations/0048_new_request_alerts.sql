-- 0048: New-request alerts — whenever a client submits a request in their
-- portal, staff get an email (SendGrid) + an app push (Expo). The portal fn
-- alerts immediately at submit time and stamps notified_at; this automation
-- polls every 5 minutes for anything un-notified (failed sends, any other
-- insert path) and retries for up to 48h. Texting is paused (RingCentral,
-- 2026-08-26), so email + push are the primary channels.

alter table portal_requests add column if not exists notified_at timestamptz;

-- Backstop scan: un-notified rows (the 48h retry window is enforced in the
-- automations-run query — index predicates can't call now()).
create index if not exists portal_requests_unnotified_idx
  on portal_requests (created_at)
  where notified_at is null;

insert into automations (kind, name, description, status, config, requested_by)
values (
  'new_request_alerts',
  'New request alerts',
  'Emails + app push to staff the moment a client submits a new request in their portal. Sent instantly at submit time; this poll re-sends anything that failed (every 5 min).',
  'enabled',
  '{"emails":["david@allsynccrm.com","valetwastefl@gmail.com"],"email":true,"push":true}'::jsonb,
  'David'
) on conflict (kind) do nothing;

create or replace function public.new_request_alerts_tick()
returns void
language plpgsql
security definer
as $$
declare
  v_token text;
begin
  -- Same auth pattern as the live ticks: Bearer = internal cron_token.
  select cron_token into v_token from public.internal_secrets where id = 1;
  if v_token is null then return; end if;
  perform net.http_post(
    url := 'https://ozoonpwuyusvksmydkuu.supabase.co/functions/v1/automations-run',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object('kind', 'new_request_alerts')
  );
end;
$$;

-- Every 5 minutes: alert any requests the portal fn couldn't notify.
select cron.schedule('new-request-alerts', '*/5 * * * *', 'select public.new_request_alerts_tick()')
where not exists (select 1 from cron.job where jobname = 'new-request-alerts');
