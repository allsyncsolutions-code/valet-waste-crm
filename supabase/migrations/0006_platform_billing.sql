-- Platform (SaaS) billing — the CRM charging the Valet Waste business $250/mo.
-- Separate money flow from Stripe Connect (which charges the business's OWN
-- customers). Single-tenant: exactly one row, id = 1.
--
-- Lives on the AllSync CRM Stripe account, driven by the STRIPE_PLATFORM_*
-- secrets and the `platform-billing` edge function.

create table if not exists public.platform_billing (
  id                     int primary key default 1,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text,          -- Stripe subscription status: active, past_due, canceled, incomplete, trialing, none
  price_id               text,
  current_period_end     timestamptz,   -- when the next charge lands
  cancel_at_period_end   boolean default false,
  updated_at             timestamptz default now(),
  constraint platform_billing_singleton check (id = 1)
);

insert into public.platform_billing (id, status) values (1, 'none')
  on conflict (id) do nothing;

alter table public.platform_billing enable row level security;

-- Staff-only, mirroring app_settings' policy. The edge function uses the
-- service role and bypasses RLS; this policy governs direct client reads.
drop policy if exists staff_all_platform_billing on public.platform_billing;
create policy staff_all_platform_billing on public.platform_billing
  for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
