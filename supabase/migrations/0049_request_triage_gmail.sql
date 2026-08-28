-- 0049: Request triage + Gmail replies (2026-08-28)
--
-- 1) portal_requests becomes a triageable ticket: staff must acknowledge each
--    client request on the Dashboard (Mark scheduled / Mark handled). The
--    base-table status CHECK lives only in the remote DB (0016 shipped
--    new/seen/done) — re-add it with 'scheduled' the same way 0037 loosened
--    route_stops.
alter table public.portal_requests drop constraint if exists portal_requests_status_check;
alter table public.portal_requests add constraint portal_requests_status_check
  check (status in ('new','seen','scheduled','done'));

alter table public.portal_requests add column if not exists resolved_at timestamptz;
alter table public.portal_requests add column if not exists resolved_by text;
alter table public.portal_requests add column if not exists resolution_note text;
alter table public.portal_requests add column if not exists replied_at timestamptz;
alter table public.portal_requests add column if not exists replied_by text;

create index if not exists portal_requests_open_idx
  on public.portal_requests (created_at desc)
  where status <> 'done';

-- Live updates for the Dashboard's open-request banner.
do $$ begin
  alter publication supabase_realtime add table public.portal_requests;
exception when duplicate_object then null; end $$;

-- 2) Gmail OAuth connection (single company Gmail used to reply to client
--    requests by email). Client id/secret are pasted in Settings by staff;
--    tokens are managed by the gmail-oauth edge function.
alter table public.app_settings
  add column if not exists gmail_client_id text,
  add column if not exists gmail_client_secret text,
  add column if not exists gmail_refresh_token text,
  add column if not exists gmail_email text,
  add column if not exists gmail_connected_by text,
  add column if not exists gmail_connected_at timestamptz,
  add column if not exists gmail_access_token text,
  add column if not exists gmail_token_expires_at timestamptz,
  add column if not exists gmail_oauth_state jsonb;

-- 3) Weekly digest of client portal requests. Suggested (not enabled) — David
--    approves it on the Automations page; "send_request_digest" on
--    automations-run works regardless for one-off sends.
insert into public.automations (kind, name, description, status, config, requested_by) values (
  'request_digest',
  'Weekly request digest',
  'Every Monday ~7:30 AM ET, emails staff a summary of every client portal request from the last 14 days — client, type, message and whether it''s still open — so nothing sits unnoticed. "Run now" sends an instant copy any day.',
  'suggested',
  '{"emails":["david@allsynccrm.com","valetwastefl@gmail.com"],"days":14}'::jsonb,
  'David'
) on conflict (kind) do nothing;
