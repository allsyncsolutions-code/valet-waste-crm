-- 0057: Shared-stop guard.
-- The same address can sit on more than one route for a date (alternate/
-- backup runs — "Randy can't do it today, Matt covers it"). Both copies are
-- independent route_stops rows, and billing (stop-billing), notifications
-- (notify-arrival/complete) and tech pay all key off the stop ROW — so if both
-- copies completed, the client would be billed/texted twice and the stop paid
-- twice. This trigger auto-skips the still-pending siblings (same property,
-- same date, same business line) the moment one copy is completed, with a
-- reason naming the winning route. Realtime pushes the skip to the other
-- driver's screen immediately. Un-doing the completion leaves siblings skipped
-- (the app's Un-skip button restores them).

create or replace function public.skip_sibling_stops()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date;
  v_line text;
  sib record;
begin
  select service_date, business_line into v_date, v_line
    from public.routes where id = new.route_id;
  if v_date is null then return new; end if;

  for sib in
    select rs.id, ru.code
      from public.route_stops rs
      join public.routes ru on ru.id = rs.route_id
     where rs.property_id is not null
       and rs.property_id = new.property_id
       and ru.service_date = v_date
       and rs.route_id <> new.route_id
       and rs.status = 'pending'
       and ru.business_line is not distinct from v_line
  loop
    update public.route_stops
       set status = 'skipped',
           skip_reason = 'Done on Route ' || sib.code,
           skipped_by = 'system',
           skipped_at = now()
     where id = sib.id;
  end loop;

  return new;
end;
$$;

create trigger route_stops_done_skip_siblings
  after update of status on public.route_stops
  for each row
  when (new.status = 'done' and old.status is distinct from 'done')
  execute function public.skip_sibling_stops();
