-- Lead source: where each customer came from (dropdown in the CRM, set
-- automatically to 'web_form' for public signup-page submissions). Free text
-- with app-level options — no check constraint, so new sources don't need a
-- migration. NULL = pre-existing customer / not recorded; reports bucket
-- those as "Not set".

alter table public.customers add column if not exists lead_source text;

create index if not exists customers_lead_source_idx on public.customers(lead_source);
