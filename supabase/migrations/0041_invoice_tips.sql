-- Customer-chosen tips on invoice payments (2026-08-26).
-- tip_amount is written at charge time (payments fn charge_invoice) and sits
-- ON TOP of invoices.total: the base total keeps meaning "service amount", so
-- autopay, reporting, and every renderer that only knows `total` are
-- unaffected unless a tip exists. Charge amount = total + tip_amount.
alter table public.invoices
  add column if not exists tip_amount numeric not null default 0;
