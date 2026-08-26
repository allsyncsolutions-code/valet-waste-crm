-- Global outbound-SMS kill switch (2026-08-26).
-- Valet Waste hit their RingCentral text limit: while sms_paused is true the
-- `sms` fn refuses every send/test (providers are never contacted, suppressed
-- sends are logged to sms_messages with status='paused'), automations fall
-- back to email, and Settings shows the pause. Flip back to false to resume.
alter table public.app_settings
  add column if not exists sms_paused boolean not null default false;
