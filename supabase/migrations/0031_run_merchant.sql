-- Run Merchant (Run Payments) — replaces Stripe for customer-facing payments
-- (invoices, portal saved cards, monthly autopay). The CRM's own SaaS
-- subscription (platform_billing) stays on Stripe.
--
-- Additive only: legacy Stripe columns are kept (historical data) but the app
-- no longer reads them. New code reads the run_* columns below.

-- 1) Merchant config on the app_settings singleton. The refresh_token is the
--    long-lived (30d) credential used to mint short-lived (1h) api_keys; we
--    cache the current api_key + its expiry so we only refresh near expiry.
alter table public.app_settings
  add column if not exists run_mid text,
  add column if not exists run_public_key text,
  add column if not exists run_refresh_token text,
  add column if not exists run_api_key text,
  add column if not exists run_api_key_expires_at timestamptz,
  add column if not exists run_refresh_token_expires_at timestamptz,
  add column if not exists run_env text not null default 'production',
  add column if not exists run_webhook_secret text;

-- 2) Per-customer Run Merchant vault references (saved card / autopay).
--    vault_id is the stored payment method; vault_holder_id is the customer
--    profile that can hold several methods. We keep only display metadata —
--    the PAN never lives in our DB.
alter table public.customers
  add column if not exists run_vault_id integer,
  add column if not exists run_vault_holder_id uuid,
  add column if not exists run_card_brand text,
  add column if not exists run_card_last4 text,
  add column if not exists run_card_exp text;

-- 3) Per-invoice Run Merchant transaction references + the portal pay link
--    (the in-portal Runner.js pay screen, since Run Merchant has no hosted
--    Checkout equivalent).
alter table public.invoices
  add column if not exists payment_url text,
  add column if not exists run_trans_id text,
  add column if not exists run_paid_at timestamptz;

-- 4) Webhook idempotency log. The X-Idempotency-Key / webhook_id is the PK so
--    retries (Run sends up to 8 over ~27h) collapse to one application.
create table if not exists public.run_webhook_events (
  webhook_id text primary key,
  event_type text not null,
  trans_id text,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now()
);

-- Backfill the autopay consent flag onto the run_* columns is intentionally
-- NOT done: Stripe PaymentMethods cannot be ported into the Run Merchant
-- vault, so existing saved cards are invalid and customers must re-save via
-- the new Runner.js form. The old autopay_consent column remains for history.
