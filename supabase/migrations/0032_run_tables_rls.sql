-- 0032: enable RLS on run_merchant tables (Supabase security alert 2026-08-17)
-- Both tables are only accessed by edge functions via the service-role key,
-- which bypasses RLS, so no policies are needed — this blocks anon access.
alter table public.run_reveal_codes enable row level security;
alter table public.run_webhook_events enable row level security;
