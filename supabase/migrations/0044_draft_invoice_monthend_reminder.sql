-- 0044: automation row for draft_invoice_monthend_reminder (handler added to
-- the automations-run fn with per-stop billing, 2026-08-26). Fires daily like
-- the other automations but only acts on the last day of the month (ET).

insert into automations (kind, name, description, status, config, requested_by)
values (
  'draft_invoice_monthend_reminder',
  'Month-end: unsent draft invoice reminder',
  'On the last day of each month, Randy texts staff a summary of still-draft invoices (count + total) so they get reviewed and sent before autopay runs on the 1st — autopay only charges SENT invoices.',
  'enabled', '{}'::jsonb,
  'David (per-stop billing, 2026-08-26)'
)
on conflict do nothing;
