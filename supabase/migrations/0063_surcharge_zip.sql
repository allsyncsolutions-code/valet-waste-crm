-- 0063_surcharge_zip.sql — Run Merchant surcharge (enabled on the MID 2026-10-01)
--
-- Once surcharge is on, Run's gateway REQUIRES the cardholder's billing zip
-- (account_zip) on every authorization — missing zip = declined with
-- "Surcharge Not Supported". The processor computes and adds the fee itself;
-- we only have to send the zip and record the fee it reports (fee_amount,
-- dollars) on the invoice.

alter table customers add column if not exists run_card_zip text;

alter table invoices add column if not exists surcharge_amount numeric(10,2) not null default 0;

-- Backfill the zip for already-vaulted cards so off-session vault charges
-- (autopay on the 1st, staff "Take payment" with card on file) keep working.
-- Source: the client's oldest property whose address ends in a 5-digit zip
-- (strips a trailing ", USA" first). Right for residential clients (billing =
-- home address); property managers get one of their properties' zips as a
-- best guess — the true zip is captured the next time they re-save a card.
update customers c
set run_card_zip = p.zip
from (
  select distinct on (customer_id) customer_id, zip from (
    select customer_id, created_at,
           substring(regexp_replace(address, ',?\s*(USA|US)\s*$', '') from '(\d{5})(?:\s*-\s*\d{4})?\s*$') as zip
    from properties
  ) z
  where z.zip is not null
  order by customer_id, created_at asc
) p
where c.run_vault_id is not null
  and coalesce(c.run_card_zip, '') = ''
  and p.customer_id = c.id;
