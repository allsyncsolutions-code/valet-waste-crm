-- Activity log (applied 2026-06-20)
-- One row per noteworthy action (created by the app or by Trashy Randy).

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  actor text not null default 'You',
  summary text not null,
  entity_type text,
  entity_id uuid,
  meta jsonb,
  created_at timestamptz default now()
);
create index if not exists activity_log_created_at_idx on public.activity_log(created_at desc);

alter table public.activity_log enable row level security;
drop policy if exists anon_all_activity_log on public.activity_log;
create policy anon_all_activity_log on public.activity_log for all to anon using (true) with check (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.activity_log;
  exception when duplicate_object then null;
  end;
end $$;
