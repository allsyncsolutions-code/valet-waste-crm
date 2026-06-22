-- Auto-renew RingCentral SMS webhook subscriptions — applied 2026-06-21
--
-- The old Replit app ran a Node loop every 6h that renewed any subscription
-- within 7 days of expiry. There is no long-running server in the new
-- serverless stack, so we replicate it with pg_cron + pg_net calling the `sms`
-- edge function's `renew_subscriptions` action on the same cadence.
--
-- ⚠️  Before this works you must store the project URL + service role key so the
--     cron can authenticate. Set them once (replace the placeholders):
--
--     select vault.create_secret('https://YOUR-REF.supabase.co', 'project_url');
--     select vault.create_secret('YOUR-SERVICE-ROLE-KEY',        'service_role_key');
--
--     (Run those in the SQL editor; never commit the key to git.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.sms_renew_subscriptions_tick()
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
    raise notice 'sms_renew: project_url / service_role_key not set in vault — skipping';
    return;
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/sms',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object('action', 'renew_subscriptions')
  );
end;
$$;

-- Every 6 hours (matches the old loop's cadence).
select cron.schedule(
  'sms-renew-subscriptions',
  '0 */6 * * *',
  $$select public.sms_renew_subscriptions_tick();$$
);
