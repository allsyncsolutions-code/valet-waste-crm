-- Decline forensics for card charges: Run/TSYS gives a response_code +
-- response_text on every failed attempt, but we were only surfacing it in
-- the transient Billing-run result row / staff text. Persist it on the
-- invoice so the "why" survives board reloads and is visible next to the
-- invoice. Cleared automatically on a successful charge or manual mark-paid.
alter table public.invoices
  add column if not exists decline_code text,
  add column if not exists decline_note text,
  add column if not exists declined_at timestamptz;

comment on column public.invoices.decline_code is 'Run/TSYS response_code from the last failed card attempt (e.g. 500, 505, 595).';
comment on column public.invoices.decline_note is 'Plain-English explanation + customer guidance for the last decline.';
comment on column public.invoices.declined_at is 'When the last card attempt declined.';
