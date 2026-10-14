-- 0066: Email receipts for the Communications page.
--
-- Texts have always been receipted in sms_messages; emails were fire-and-forget
-- via SendGrid. Edge fns now write a row here after every send attempt (success
-- AND failure) so staff can open any message and see exactly what was sent,
-- to whom, when, and what it said. Same anon-all access model as sms_messages
-- (0003) since the CRM's data layer calls PostgREST with the anon key.
create table if not exists public.email_messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  direction text not null default 'out',
  to_email text not null,
  from_email text,
  subject text,
  body_text text,
  body_html text,
  status text not null default 'sent',   -- sent | failed
  error text,
  provider text not null default 'sendgrid',
  purpose text,                          -- invoice | reminder | arrival | complete | service_reminder | staff_alert | reset | other
  customer_id uuid references public.customers(id) on delete set null,
  sent_by text,
  related_type text,                     -- e.g. 'invoice'
  related_id text                        -- e.g. invoice uuid / number
);

create index if not exists email_messages_created_idx on public.email_messages (created_at desc);
create index if not exists email_messages_customer_idx on public.email_messages (customer_id);
create index if not exists email_messages_to_idx on public.email_messages (to_email);

alter table public.email_messages enable row level security;

drop policy if exists anon_all_email_messages on public.email_messages;
create policy anon_all_email_messages on public.email_messages
  for all to anon
  using (true)
  with check (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.email_messages;
  exception when duplicate_object then null;
  end;
end $$;
