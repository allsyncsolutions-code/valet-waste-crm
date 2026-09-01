-- 0053: Anthropic token telemetry for dispatch-ai (Trashy Randy).
--
-- Every dispatch-ai request logs one row: caller, request shape, and the
-- token counts Anthropic reports (input/output EXCLUDE cache read/write —
-- the four columns are mutually exclusive buckets). This is how we watch
-- API spend and verify prompt caching is actually hitting
-- (cache_read_tokens >> input_tokens on repeat calls within the TTL).

create table if not exists public.ai_usage (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  caller             text,
  sms                boolean not null default false,
  turns              int,
  iterations         int,
  input_tokens       int not null default 0,
  output_tokens      int not null default 0,
  cache_write_tokens int not null default 0,
  cache_read_tokens  int not null default 0
);

create index if not exists ai_usage_created_idx on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;
drop policy if exists staff_read_ai_usage on public.ai_usage;
create policy staff_read_ai_usage on public.ai_usage
  for select to authenticated using (public.is_staff());
-- Writes come from the edge function with the service role key (bypasses RLS).
