-- 0056 — Bill-to override on invoices (name / email / phone).
--
-- Property managers sometimes need the invoice to carry their END CLIENT's
-- name for insurance purposes. These columns override what the invoice
-- DOCUMENT shows (emailed HTML invoice, portal pay page, staff preview, PDF)
-- while the invoice itself stays assigned to — and is paid by — the property
-- manager's customer record. Blank/NULL keeps today's behavior: the fields
-- render from the assigned customer. Purely presentational: sends, reminders,
-- autopay and the pay link are untouched and always use the real customer.

alter table public.invoices
  add column if not exists bill_to_name text,
  add column if not exists bill_to_email text,
  add column if not exists bill_to_phone text;
