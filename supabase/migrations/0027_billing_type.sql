-- 0027: Subscription vs single-payment clients.
-- billing_type distinguishes recurring (subscription) clients from
-- one-time / on-demand (single payment) clients — e.g. the ~209 Thrive
-- single-payment clients being added. Everything existing stays 'subscription'.
alter table public.customers
  add column if not exists billing_type text not null default 'subscription';

do $$ begin
  alter table public.customers
    add constraint customers_billing_type_chk
    check (billing_type in ('subscription', 'one_time'));
exception when duplicate_object then null; end $$;

create index if not exists idx_customers_billing_type on public.customers (billing_type);
