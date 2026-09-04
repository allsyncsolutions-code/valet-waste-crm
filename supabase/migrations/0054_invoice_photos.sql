-- Manual proof-of-service photos attached directly to an invoice — for past
-- services the driver never captured in the app. stop_id links a photo to the
-- specific visit the admin picked from the client's service history (those
-- render inside the matching line item); null stop_id photos render in the
-- invoice's trailing "Service photos" grid. Files live in the existing public
-- `stop-photos` bucket under inv/<invoice_id>/ so no new bucket is needed.
create table if not exists public.invoice_photos (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  stop_id uuid references public.route_stops(id) on delete set null,
  path text not null,
  taken_on date,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists invoice_photos_invoice_idx on public.invoice_photos (invoice_id);

alter table public.invoice_photos enable row level security;

drop policy if exists staff_all_invoice_photos on public.invoice_photos;
create policy staff_all_invoice_photos on public.invoice_photos
  for all to authenticated
  using (true)
  with check (true);
