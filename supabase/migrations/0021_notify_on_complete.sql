-- Global on/off for the "service complete" text (default OFF). Randy toggles it
-- in Settings; Trashy Randy can flip it via a dispatch-ai tool.
alter table public.app_settings
  add column if not exists notify_on_complete boolean not null default false;

comment on column public.app_settings.notify_on_complete is
  'Master switch for the check-out "service complete" SMS. Per-contact notify_on_service still applies.';

-- Idempotency guard so a stop only ever fires one completion text.
alter table public.route_stops
  add column if not exists complete_notified_at timestamptz;
