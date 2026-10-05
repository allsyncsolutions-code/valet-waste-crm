-- 0065: Global notification toggles for the business-facing Notifications tab.
--
-- notification_toggles is a JSONB map of notification-type → boolean, owned by
-- the Notifications tab in the web CRM (staff write app_settings via the
-- existing staff_all_app_settings policy). Edge fns read it before sending;
-- a missing key means ON (backward compatible with rows written before
-- this column existed).
--
-- Keys:
--   client_arrival        "tech is at your property" push/SMS/email
--   client_complete       service-complete + photos push/SMS/email
--   client_invoice_email  invoice & reminder emails (SendGrid)
--   client_invoice_sms    invoice & reminder texts
--   client_portal_invite  portal-ready invite email+SMS (5th-week-free pitch)
--   client_service_reminder day-before pickup reminder (push/email)
--   team_new_property     new-property alert to admins (SMS+email+push)
--   team_payment_events   paid/declined/refund texts to admins
--   team_automation_alerts staff alerts fired by automation rules

alter table public.app_settings
  add column if not exists notification_toggles jsonb not null default '{}'::jsonb;

update public.app_settings
set notification_toggles = jsonb_build_object(
  'client_arrival', true,
  'client_complete', true,
  'client_invoice_email', true,
  'client_invoice_sms', true,
  'client_portal_invite', true,
  'client_service_reminder', true,
  'team_new_property', true,
  'team_payment_events', true,
  'team_automation_alerts', true
)
where id = 1
  and (notification_toggles is null or notification_toggles = '{}'::jsonb);
