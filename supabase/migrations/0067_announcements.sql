-- 0067: Announcements — aggregate history rows for bulk text/email blasts
-- sent from the Announcements tab. One row per blast (the `announcements`
-- edge function creates it on the first chunk and accumulates per-chunk
-- counts). Per-message receipts live in sms_messages / email_messages with
-- purpose 'announcement', exactly like every other customer message.
--
-- STAGED ONLY — do not apply until the owner approves it in-session
-- (AGENTS.md: schema changes require owner approval).

create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  channel text not null,                       -- sms | email | both
  audience_label text not null,                -- human summary of the filters
  filters jsonb not null default '{}'::jsonb,  -- the exact filter set used
  subject text,
  body text not null,
  counts jsonb not null default '{}'::jsonb,   -- { sentSms, failedSms, pausedSms, skippedOptOut, sentEmail, failedEmail }
  sent_by uuid,                                -- profiles id of the sender
  sent_by_name text
);

create index if not exists announcements_created_idx on public.announcements(created_at desc);

alter table public.announcements enable row level security;

-- Same staff-read model as the comms tables: signed-in CRM users can read
-- their blast history; writes come from the edge function (service role,
-- which bypasses RLS).
drop policy if exists staff_read_announcements on public.announcements;
create policy staff_read_announcements on public.announcements
  for select to authenticated
  using (true);

drop policy if exists anon_read_announcements on public.announcements;
create policy anon_read_announcements on public.announcements
  for select to anon
  using (true);
