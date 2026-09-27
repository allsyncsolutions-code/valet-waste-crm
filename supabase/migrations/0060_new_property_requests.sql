-- 0060: New-property requests from the client portal.
-- Clients can now ask for a NEW service address in their portal (kind =
-- 'new_property'). The structured answers — address, requested day(s),
-- frequency, access notes (gate codes etc.) — live in the new `details` jsonb
-- column: {address, days[], frequency, notes}. The triage flow (CRM Dashboard
-- + mobile app) reads `details` to offer "Approve & add to schedule", which
-- creates the property with pickup_days/pickup_frequency/pickup_start_date.
-- The human-readable summary is ALSO composed into `message` at submit time so
-- the existing alert paths (portal fn + new_request_alerts backstop, mig 0048)
-- render a complete email/push without knowing about the new shape.
--
-- No new column on properties: the "NEW" badge in Routes and the portal derives
-- from properties.created_at (30-day window), per owner decision 2026-09-27.

alter table public.portal_requests
  add column if not exists details jsonb;

-- kind CHECK (from 0016) needs the new value. Status constraint already
-- widened by 0049 and is untouched.
alter table public.portal_requests drop constraint if exists portal_requests_kind_check;
alter table public.portal_requests add constraint portal_requests_kind_check
  check (kind in ('extra_pickup','junk_removal','lawn_care','billing','other','new_property'));
