-- Mark-paid payment details (2026-10-01)
-- "Mark paid" now records HOW an invoice was paid: payment_method is one of
-- cash | check | zelle | cash_app | venmo | credit (Valet-Waste credit) |
-- service_swap | other for manual marks, or 'card' when a gateway charge
-- (portal pay page, staff take-payment, autopay, webhook) flips the invoice.
-- check_number + payment_note are free text; all three are display-only.

alter table public.invoices
  add column if not exists payment_method text,
  add column if not exists check_number text,
  add column if not exists payment_note text;

-- Backfill: invoices already paid through the Run gateway have a transaction
-- id on them — call those Card (online). Older manual marks stay unlabeled.
update public.invoices
   set payment_method = 'card'
 where status = 'paid'
   and run_trans_id is not null
   and payment_method is null;
