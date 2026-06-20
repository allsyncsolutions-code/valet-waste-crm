-- Invoices + line items (applied 2026-06-20)
-- Real invoice records distinct from invoice_schedules (recurring-billing config).

-- Sequential invoice numbers (INV-1001, INV-1002, …)
create sequence if not exists invoice_number_seq start 1001;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  number text not null unique default ('INV-' || lpad(nextval('invoice_number_seq')::text, 4, '0')),
  status text not null default 'draft' check (status in ('draft','sent','paid','void')),
  issue_date date default current_date,
  due_date date,
  notes text,
  discount numeric not null default 0,
  subtotal numeric not null default 0,
  total numeric not null default 0,
  stripe_payment_url text,
  sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references public.invoices(id) on delete cascade,
  description text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  amount numeric not null default 0,
  position integer not null default 0,
  created_at timestamptz default now()
);

create index if not exists invoices_customer_id_idx on public.invoices(customer_id);
create index if not exists invoice_line_items_invoice_id_idx on public.invoice_line_items(invoice_id);

alter table public.invoices enable row level security;
alter table public.invoice_line_items enable row level security;

drop policy if exists anon_all_invoices on public.invoices;
drop policy if exists anon_all_invoice_line_items on public.invoice_line_items;
create policy anon_all_invoices on public.invoices for all to anon using (true) with check (true);
create policy anon_all_invoice_line_items on public.invoice_line_items for all to anon using (true) with check (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.invoices;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.invoice_line_items;
  exception when duplicate_object then null;
  end;
end $$;
