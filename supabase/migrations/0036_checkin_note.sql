-- 0036: free-form note a tech can attach to a stop at check-in time
-- (distinct from skip_reason, which only exists for skipped stops).
-- Searched and shown in the per-address archive (web Clients + mobile Field).
alter table public.route_stops
  add column if not exists checkin_note text;
