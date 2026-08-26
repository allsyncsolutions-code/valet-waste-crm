-- 0043: per-stop invoice drafting. One-time stops (junk removal etc.) carry
-- their own title/description/price on route_stops, and every invoice line
-- item created from a stop references it — the unique index is the
-- double-billing guard (a stop can only ever land on one line item).

alter table route_stops
  add column if not exists job_title text,
  add column if not exists job_description text,
  add column if not exists job_price numeric;

alter table invoice_line_items
  add column if not exists stop_id uuid references route_stops(id) on delete set null;

-- One line item per stop, ever.
create unique index if not exists uq_invoice_line_items_stop_id
  on invoice_line_items (stop_id) where stop_id is not null;
