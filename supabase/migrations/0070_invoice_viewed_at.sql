-- invoices.viewed_at — set by the payments edge function (invoice_viewed
-- action) the first time a customer opens an invoice's pay link. Powers the
-- "Viewed" badge on the Billing run board so staff can see which sent
-- invoices a client has actually looked at before following up.

alter table public.invoices
  add column if not exists viewed_at timestamptz;

comment on column public.invoices.viewed_at is
  'First time the customer opened the invoice pay link (stamped server-side by the payments fn).';
