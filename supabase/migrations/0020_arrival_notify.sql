-- Per-contact override for the "tech has arrived" text.
--   NULL  = auto (send only if this contact is tied to exactly one property)
--   TRUE  = always notify (force on, even for multi-location contacts)
--   FALSE = never notify (force off, even for single-property contacts)
alter table public.customers
  add column if not exists notify_on_service boolean;

comment on column public.customers.notify_on_service is
  'Arrival-text override. NULL=auto (single-property only), TRUE=always, FALSE=never.';

-- Idempotency guard so a stop only ever fires one arrival text.
alter table public.route_stops
  add column if not exists arrival_notified_at timestamptz;
