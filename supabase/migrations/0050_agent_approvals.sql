-- 0050: Agent approval return channel (2026-08-31)
--
-- Coding agents (Claude Code / ZCode / Kimi) email blocking questions to
-- dev-agents@allsynccrm.com per AGENTS.md. The agent-mail edge function
-- connects the company Outlook mailbox (Microsoft Graph, same pattern as the
-- Gmail card), polls it every 2 minutes, stores each AGENT-QUESTION, pushes
-- David a notification, and when his reply starts with APPROVE:/REJECT/CLARIFY
-- posts the decision back to the originating GitHub PR/issue.

-- Outlook (Microsoft Graph) connection + GitHub token — pasted in Settings →
-- Agent approvals; tokens managed by the agent-mail edge function.
alter table public.app_settings
  add column if not exists agentmail_client_id text,
  add column if not exists agentmail_client_secret text,
  add column if not exists agentmail_tenant text,
  add column if not exists agentmail_refresh_token text,
  add column if not exists agentmail_email text,
  add column if not exists agentmail_connected_by text,
  add column if not exists agentmail_connected_at timestamptz,
  add column if not exists agentmail_access_token text,
  add column if not exists agentmail_token_expires_at timestamptz,
  add column if not exists agentmail_oauth_state jsonb,
  add column if not exists agentmail_github_token text,
  add column if not exists agentmail_last_poll_at timestamptz;

-- One row per blocking question an agent has asked.
create table if not exists public.agent_questions (
  id uuid primary key default gen_random_uuid(),
  question_id text unique,                     -- aq_YYYYMMDD_… from the email body
  project text,
  repo text,                                   -- e.g. allsyncsolutions-code/valet-waste-crm
  branch text,
  source text,                                 -- Claude Code / ZCode / Kimi / …
  return_channel text,                         -- github-pr-comment (only channel for now)
  pr_number int,
  issue_number int,
  subject text,
  body text,
  from_email text,
  message_id text,                             -- internet message id of the question email
  conversation_id text,                        -- Outlook conversationId (matches replies)
  status text not null default 'pending'
    check (status in ('pending','answered','posted','error','ignored')),
  decision text,                               -- APPROVE / REJECT / CLARIFY
  decision_body text,                          -- David's full reply (unquoted part)
  decision_message_id text,
  github_comment_url text,
  error text,
  received_at timestamptz,
  answered_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists agent_questions_status_idx
  on public.agent_questions (created_at desc) where status = 'pending';
create index if not exists agent_questions_conversation_idx
  on public.agent_questions (conversation_id);

alter table public.agent_questions enable row level security;
do $$ begin
  create policy "staff read agent questions" on public.agent_questions
    for select to authenticated using (public.is_staff());
exception when duplicate_object then null; end $$;

-- Live updates for the Settings card.
do $$ begin
  alter publication supabase_realtime add table public.agent_questions;
exception when duplicate_object then null; end $$;

-- Poll dedupe: which mailbox messages we've already looked at (pruned by the
-- edge function after 14 days). Service-role only — RLS on, no policies.
create table if not exists public.agent_mail_seen (
  message_id text primary key,
  seen_at timestamptz not null default now()
);
alter table public.agent_mail_seen enable row level security;

-- Poll the mailbox every 2 minutes (no-ops instantly until Outlook is
-- connected). Same cron_token auth pattern as the other ticks.
create or replace function public.agent_mail_poll_tick()
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
    url := 'https://ozoonpwuyusvksmydkuu.supabase.co/functions/v1/agent-mail',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object('action', 'poll')
  );
end;
$$;

select cron.schedule('agent-mail-poll', '*/2 * * * *', 'select public.agent_mail_poll_tick()')
where not exists (select 1 from cron.job where jobname = 'agent-mail-poll');
