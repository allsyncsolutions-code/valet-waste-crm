-- Staff "Forgot password?" reset codes (used by the staff-reset edge function).
-- One row per emailed 6-digit code; hashed, one-time, 10-minute expiry.
-- Service-role only: RLS is enabled with NO policies on purpose.

create table if not exists public.staff_reset_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists staff_reset_codes_hash_idx on public.staff_reset_codes (code_hash);
create index if not exists staff_reset_codes_user_idx on public.staff_reset_codes (user_id, created_at desc);

alter table public.staff_reset_codes enable row level security;
-- No policies: only the service role (edge function) may touch this table.
