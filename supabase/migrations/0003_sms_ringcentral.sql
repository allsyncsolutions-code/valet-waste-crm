-- RingCentral SMS (ported from the old Replit CRM) — applied 2026-06-21
--
-- Texting model:
--   • Non-secret config lives on app_settings (anon-readable; safe to ship).
--   • Secrets (Client Secret, JWT, webhook verification token) live in a
--     separate sms_secrets table with RLS enabled and NO anon policy, so the
--     browser can never read them back. Only the edge functions (service role,
--     which bypasses RLS) touch that table. The UI shows a "saved" placeholder.
--   • sms_messages logs every outbound + inbound text for the Activity view.
--
-- Provider priority mirrors the old app: when RingCentral SMS is enabled and
-- configured, it is used; otherwise the app falls back to Telnyx.

-- 1) Non-secret RingCentral config on the singleton settings row -------------
alter table public.app_settings
  add column if not exists sms_enabled       boolean not null default false,
  add column if not exists sms_from_number   text,
  add column if not exists rc_server_url      text not null default 'https://platform.ringcentral.com',
  add column if not exists rc_client_id       text,
  -- presence flags so the UI can render "saved — enter new value to replace"
  add column if not exists rc_secret_set      boolean not null default false,
  add column if not exists rc_jwt_set         boolean not null default false,
  add column if not exists rc_webhook_token_set boolean not null default false;

-- 2) Locked-down secrets table (edge-function-only) -------------------------
create table if not exists public.sms_secrets (
  id integer primary key default 1,
  rc_client_secret             text,
  rc_jwt                       text,
  rc_webhook_verification_token text,
  updated_at timestamptz default now(),
  constraint sms_secrets_singleton check (id = 1)
);
insert into public.sms_secrets (id) values (1) on conflict (id) do nothing;

-- RLS on, but intentionally NO policy for anon/authenticated → fully denied to
-- the browser. The service role used by edge functions bypasses RLS entirely.
alter table public.sms_secrets enable row level security;
revoke all on public.sms_secrets from anon, authenticated;

-- 3) Message log (outbound + inbound) ---------------------------------------
create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  direction   text not null check (direction in ('out','in')),
  provider    text,                    -- 'ringcentral' | 'telnyx'
  to_number   text,
  from_number text,
  body        text,
  status      text,                    -- 'sent' | 'failed' | 'received'
  error       text,
  customer_id uuid references public.customers(id) on delete set null,
  external_id text,                    -- provider message id
  raw         jsonb,                   -- raw inbound payload (debugging)
  created_at  timestamptz default now()
);
create index if not exists sms_messages_created_at_idx on public.sms_messages(created_at desc);
create index if not exists sms_messages_customer_id_idx on public.sms_messages(customer_id);

alter table public.sms_messages enable row level security;
drop policy if exists anon_all_sms_messages on public.sms_messages;
create policy anon_all_sms_messages on public.sms_messages for all to anon using (true) with check (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.sms_messages;
  exception when duplicate_object then null;
  end;
end $$;
