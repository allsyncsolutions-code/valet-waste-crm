-- Invoice branding: business contact info shown on invoices + default
-- terms & conditions that populate every invoice. Formatting is a light
-- markdown subset (**bold**, *italic*, __underline__, "- " bullets) stored
-- as plain text so the mobile app can still render it readably.
alter table public.app_settings
  add column if not exists company_phone text,
  add column if not exists company_email text,
  add column if not exists company_address text,
  add column if not exists invoice_terms text;
