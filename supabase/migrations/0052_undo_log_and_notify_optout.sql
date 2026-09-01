-- 0052: "Reverse last action" undo log + client notification opt-out tokens.
--
-- undoable_actions snapshots the before-state of every mutating field action
-- (from dispatch-ai / Trashy Randy, the web CRM, and the mobile app) so a
-- single undo_action() call can put it back. undo_latest() picks the most
-- recent not-yet-undone row for a source — that is the ↩ button / "undo that".
--
-- customers.notify_optout_token is a lazy-minted bearer token (same model as
-- portal_share_token, 0019): the notify fns mint it the first time they email
-- a client, and the link {fn}/notify-prefs?token=<t> opts the client out of
-- visit notifications (sets notify_on_service=false + reserved tag).

alter table public.customers add column if not exists notify_optout_token text unique;

create table if not exists public.undoable_actions (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('web','mobile','randy')),
  actor        text,
  action_type  text not null,   -- stop_status | stop_removed | stop_moved | route_optimized | day_override
  entity_table text,
  entity_id    uuid,
  before       jsonb not null,  -- exact prior state needed to reverse
  after        jsonb,
  created_at   timestamptz not null default now(),
  undone_at    timestamptz,
  undone_by    text
);

create index if not exists undoable_actions_latest_idx
  on public.undoable_actions (source, created_at desc) where undone_at is null;

alter table public.undoable_actions enable row level security;
drop policy if exists staff_all_undoable_actions on public.undoable_actions;
create policy staff_all_undoable_actions on public.undoable_actions
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Reserved opt-out tag, seeded once. The notify-prefs fn re-uses this row by
-- name; presence in the tag list is what makes opt-outs visible to staff/Randy.
insert into public.tags (name, color)
select 'No Service Notifications', '#8a6414'
where not exists (select 1 from public.tags where name ilike 'No Service Notifications');

-- Reverse one logged action. Restores route_stops state only — a notice already
-- sent or an invoice line already drafted is NOT recalled (arrival/complete
-- notified-at guards stay consumed so a re-check-in can't double-notify).
create or replace function public.undo_action(p_id uuid, p_undone_by text default null)
returns jsonb
language plpgsql
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_row public.undoable_actions%rowtype;
  v_stop jsonb;
  v_address text;
  v_seq int;
begin
  if not (public.is_staff() or current_user in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Staff only.';
  end if;

  select * into v_row from public.undoable_actions
  where id = p_id and undone_at is null
  for update;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'note', 'Nothing to undo — that action is gone or already reversed.');
  end if;

  v_stop := coalesce(v_row.before->'stop', v_row.before);

  if v_row.action_type = 'stop_removed' then
    -- Re-insert the deleted row with its original id (photos/history survive).
    insert into public.route_stops
    select * from jsonb_populate_record(null::public.route_stops, v_row.before)
    on conflict (id) do nothing;

  elsif v_row.action_type = 'route_optimized' then
    -- before = [{stop_id, seq}, ...] — put every seq back.
    update public.route_stops rs
    set seq = elem.seq
    from jsonb_to_recordset(v_row.before) as elem(stop_id uuid, seq int)
    where rs.id = elem.stop_id;

  elsif v_row.action_type = 'day_override' then
    -- Remove the override row and restore the stop's prior placement.
    delete from public.property_day_overrides where id = (v_row.before->>'override_id')::uuid;
    update public.route_stops rs
    set route_id = (v_stop->>'route_id')::uuid,
        seq     = (v_stop->>'seq')::int,
        status  = v_stop->>'status'
    where rs.id = v_row.entity_id;

  elsif v_row.action_type = 'stop_moved' then
    update public.route_stops rs
    set route_id = (v_stop->>'route_id')::uuid,
        seq     = (v_stop->>'seq')::int
    where rs.id = v_row.entity_id;

  else
    -- stop_status / skip / unskip / check-in / check-out / on-my-way / reset:
    -- restore the operational fields exactly as they were.
    update public.route_stops rs
    set status        = v_stop->>'status',
        check_in      = (v_stop->>'check_in')::timestamptz,
        check_out     = (v_stop->>'check_out')::timestamptz,
        check_in_lat  = (v_stop->>'check_in_lat')::numeric,
        check_in_lng  = (v_stop->>'check_in_lng')::numeric,
        check_out_lat = (v_stop->>'check_out_lat')::numeric,
        check_out_lng = (v_stop->>'check_out_lng')::numeric,
        on_my_way_at  = (v_stop->>'on_my_way_at')::timestamptz,
        skip_reason   = v_stop->>'skip_reason',
        skipped_by    = v_stop->>'skipped_by',
        skipped_at    = (v_stop->>'skipped_at')::timestamptz
    where rs.id = v_row.entity_id;
  end if;

  update public.undoable_actions
  set undone_at = now(), undone_by = coalesce(p_undone_by, v_row.actor)
  where id = v_row.id;

  v_seq := nullif(v_stop->>'seq', '')::int;
  select p.address into v_address
  from public.route_stops rs join public.properties p on p.id = rs.property_id
  where rs.id = v_row.entity_id;
  if v_address is null and v_row.action_type = 'stop_removed' then
    select p.address into v_address
    from public.properties p
    where p.id = (v_row.before->>'property_id')::uuid;
  end if;

  return jsonb_build_object('ok', true, 'action_type', v_row.action_type,
    'source', v_row.source, 'seq', v_seq, 'address', v_address);
end $function$;

-- Undo the most recent action for a source (the ↩ button / "undo that").
-- p_source null = any source. Window defaults to an hour.
create or replace function public.undo_latest(
  p_source text default null,
  p_within_minutes int default 60,
  p_undone_by text default null
)
returns jsonb
language plpgsql
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if not (public.is_staff() or current_user in ('service_role', 'postgres', 'supabase_admin')) then
    raise exception 'Staff only.';
  end if;

  select id into v_id from public.undoable_actions
  where undone_at is null
    and created_at > now() - (coalesce(p_within_minutes, 60) || ' minutes')::interval
    and (p_source is null or source = p_source)
  order by created_at desc
  limit 1;

  if v_id is null then
    return jsonb_build_object('ok', false, 'note', 'Nothing recent to undo.');
  end if;

  return public.undo_action(v_id, p_undone_by);
end $function$;
