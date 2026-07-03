-- Self-contained cron auth — applied 2026-07-03. A dedicated internal token
-- (generated in-database; NEVER committed to git) replaces the service-role
-- key in the cron path, so the pg_cron jobs run with zero manual secret setup.
create table if not exists public.internal_secrets (
  id integer primary key default 1,
  cron_token text not null,
  created_at timestamptz default now(),
  constraint internal_secrets_singleton check (id = 1)
);
insert into public.internal_secrets (id, cron_token)
values (1, encode(gen_random_bytes(32), 'hex'))
on conflict (id) do nothing;
alter table public.internal_secrets enable row level security;
revoke all on public.internal_secrets from anon, authenticated;

create or replace function public.automations_run_tick()
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
    body := '{}'::jsonb
  );
end;
$$;

create or replace function public.sms_renew_subscriptions_tick()
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
    url := 'https://ozoonpwuyusvksmydkuu.supabase.co/functions/v1/sms',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object('action', 'renew_subscriptions')
  );
end;
$$;

-- Lawn techs are paid monthly: on the 1st, for the previous month.
update public.app_settings set pay_cadence = 'monthly' where id = 1;
