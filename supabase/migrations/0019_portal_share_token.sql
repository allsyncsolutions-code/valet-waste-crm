-- 0019 (applied 2026-07-07): read-only homeowner share links — one shareable
-- token per customer. Portal fn mints it on demand (share_link action);
-- ?share=<token> renders a login-free, view-only portal (no billing).
alter table public.customers add column if not exists portal_share_token text unique;
