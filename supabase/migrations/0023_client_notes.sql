-- Per-client notes LOG: a running, timestamped history of notes staff leave on a
-- client, separate from the single free-text customers.notes summary field.
-- Shown newest-first in the client detail panel (Clients view).
create table if not exists public.client_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  author_id uuid references auth.users(id),
  author_name text,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists client_notes_customer_idx
  on public.client_notes (customer_id, created_at desc);

alter table public.client_notes enable row level security;
drop policy if exists staff_all_client_notes on public.client_notes;
create policy staff_all_client_notes on public.client_notes
  for all to authenticated using (is_staff()) with check (is_staff());
