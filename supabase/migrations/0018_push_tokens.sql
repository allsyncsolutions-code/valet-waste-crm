-- 0018: Expo push tokens (applied 2026-07-06). One row per device; the mobile
-- app upserts its own token, the push edge function (service role) reads them.
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique,
  platform text,
  updated_at timestamptz not null default now()
);

alter table public.push_tokens enable row level security;

drop policy if exists push_tokens_own on public.push_tokens;
create policy push_tokens_own on public.push_tokens
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create index if not exists push_tokens_profile_idx on public.push_tokens (profile_id);
