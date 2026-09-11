-- 0058: Client push notifications foundation.
-- push_tokens.customer_id (0047) was added for client-app users but nothing
-- could write it: profile_id is NOT NULL and the RLS policy requires a staff
-- auth session. Client tokens are written by the portal function (service
-- role, authenticated by the client's portal session token), so profile_id
-- just needs to be nullable. The existing authenticated-RLS keeps direct
-- client writes blocked (profile_id = auth.uid() never matches NULL).
alter table public.push_tokens
  alter column profile_id drop not null;

-- Channel-level notification prefs, managed by the client in their portal
-- (🔔 Notifications card). Master opt-out customers.notify_on_service=false
-- (the email-footer unsubscribe) still silences service notifications on ALL
-- channels; these toggles are the per-channel layer underneath.
alter table public.customers
  add column if not exists notify_sms bool not null default true,
  add column if not exists notify_push bool not null default true,
  add column if not exists notify_email bool not null default true;

-- Day-before service reminder automation (paused until David enables it).
insert into automations (kind, name, description, status, config, requested_by)
values (
  'service_reminders',
  'Day-before service reminders',
  'Notifies clients the morning before their scheduled pickup day ("Your pickup at 123 Main St is tomorrow"). Push by default (clients who haven''t signed into the app are skipped — they keep their normal texts), optional email. Runs on the 7:30 AM ET daily tick.',
  'paused',
  '{"push":true,"email":false,"lastSentDate":null}'::jsonb,
  'David'
) on conflict (kind) do nothing;
