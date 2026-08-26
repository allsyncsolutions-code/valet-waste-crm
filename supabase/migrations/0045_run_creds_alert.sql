-- 0045: rate-limit marker for the "Run Payments credentials rejected" admin
-- email (portal fn alerts at most every 6h while creds are dead).
alter table app_settings add column if not exists run_creds_alerted_at timestamptz;
