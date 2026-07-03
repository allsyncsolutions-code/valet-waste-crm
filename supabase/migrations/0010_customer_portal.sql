-- Customer portal: per-client shareable slug, email magic links, sessions,
-- excess-pickup flags, and a persistent business logo. Applied 2026-07-02.
create extension if not exists pgcrypto;

-- 1) Shareable per-client slug (identifies the client; never grants access)
alter table public.customers
  add column if not exists portal_slug text unique default encode(gen_random_bytes(9), 'hex');
update public.customers set portal_slug = encode(gen_random_bytes(9), 'hex') where portal_slug is null;

-- 2) One-time login codes emailed via SendGrid (store hashes only)
create table if not exists public.portal_magic_links (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists portal_magic_links_customer_idx on public.portal_magic_links(customer_id);
alter table public.portal_magic_links enable row level security;
revoke all on public.portal_magic_links from anon, authenticated;

-- 3) Portal sessions (30-day bearer tokens; hashes only)
create table if not exists public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  created_at timestamptz default now()
);
alter table public.portal_sessions enable row level security;
revoke all on public.portal_sessions from anon, authenticated;

-- 4) Excess-pickup flag captured at driver checkout.
--    pending -> Randy drafts invoice line (drafted) -> admin approves/dismisses.
alter table public.route_stops
  add column if not exists excess_flagged boolean not null default false,
  add column if not exists excess_note text,
  add column if not exists excess_status text check (excess_status in ('pending','drafted','approved','dismissed')),
  add column if not exists excess_amount numeric,
  add column if not exists excess_reviewed_by text,
  add column if not exists excess_reviewed_at timestamptz;

-- 5) Persistent logo (replaces the localStorage-only "C" block)
alter table public.app_settings add column if not exists logo_url text;

-- 6) Public branding bucket for the logo
insert into storage.buckets (id, name, public) values ('branding', 'branding', true)
on conflict (id) do nothing;
drop policy if exists staff_write_branding on storage.objects;
create policy staff_write_branding on storage.objects
  for all to authenticated
  using (bucket_id = 'branding' and is_staff())
  with check (bucket_id = 'branding' and is_staff());
