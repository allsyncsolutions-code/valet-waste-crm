-- 0040: "Send in the future" for invoices — a scheduled-send queue processed
-- by the automations-run fn every 5 minutes. Times are chosen in Eastern
-- time by the user and stored as timestamptz (UTC).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists invoice_scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  channel text not null check (channel in ('sms','email','both')),
  send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_scheduled_sends_due on invoice_scheduled_sends (status, send_at);

-- Service-role only (edge fns read/write it); no RLS policies for clients.
alter table invoice_scheduled_sends enable row level security;

create or replace function public.scheduled_invoice_sends_tick()
returns void
language plpgsql
security definer
as $$
declare
  v_token text;
begin
  -- Same auth pattern as the live automations_run_tick(): the fn accepts the
  -- internal cron_token as Bearer. (The vault-secrets pattern from 0004/0009
  -- was superseded — the vault holds no secrets on this project.)
  select cron_token into v_token from public.internal_secrets where id = 1;
  if v_token is null then return; end if;
  perform net.http_post(
    url := 'https://ozoonpwuyusvksmydkuu.supabase.co/functions/v1/automations-run',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object('action', 'scheduled_sends')
  );
end;
$$;

-- Every 5 minutes: deliver any pending scheduled invoice sends that are due.
select cron.schedule('scheduled-invoice-sends', '*/5 * * * *', 'select public.scheduled_invoice_sends_tick()')
where not exists (select 1 from cron.job where jobname = 'scheduled-invoice-sends');
