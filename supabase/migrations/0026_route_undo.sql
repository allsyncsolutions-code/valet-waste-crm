-- 0026: Undo for route deletions.
-- delete_route now snapshots everything it removes (catalog row, dated routes,
-- stops) into deleted_routes, and restore_route(snapshot_id) puts it all back.

create table if not exists public.deleted_routes (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name       text,
  payload    jsonb not null,           -- { def: {...}, routes: [...], stops: [...] }
  deleted_by text,
  deleted_at timestamptz not null default now()
);

alter table public.deleted_routes enable row level security;
drop policy if exists staff_all_deleted_routes on public.deleted_routes;
create policy staff_all_deleted_routes on public.deleted_routes
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Replace delete_route: snapshots before deleting and returns the snapshot id
-- so the UI can offer Undo. Drop the old 1-arg version first — keeping both
-- would make PostgREST rpc calls ambiguous.
drop function if exists public.delete_route(text);
create or replace function public.delete_route(p_code text, p_deleted_by text default null)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_code text := upper(trim(p_code));
  v_stops int := 0;
  v_routes int := 0;
  v_payload jsonb;
  v_snapshot uuid;
  v_name text;
begin
  if v_code is null or v_code = '' then
    raise exception 'A route code is required.';
  end if;

  select coalesce(name, 'Route ' || v_code) into v_name
    from public.route_defaults where upper(code) = v_code limit 1;

  select jsonb_build_object(
    'def',    (select to_jsonb(d) from public.route_defaults d where upper(d.code) = v_code),
    'routes', coalesce((select jsonb_agg(to_jsonb(r)) from public.routes r where upper(r.code) = v_code), '[]'::jsonb),
    'stops',  coalesce((select jsonb_agg(to_jsonb(rs)) from public.route_stops rs
                         join public.routes r on r.id = rs.route_id
                        where upper(r.code) = v_code), '[]'::jsonb)
  ) into v_payload;

  insert into public.deleted_routes (code, name, payload, deleted_by)
  values (v_code, v_name, v_payload, p_deleted_by)
  returning id into v_snapshot;

  delete from public.route_stops rs
    using public.routes r
    where rs.route_id = r.id and upper(r.code) = v_code;
  get diagnostics v_stops = row_count;
  delete from public.routes where upper(code) = v_code;
  get diagnostics v_routes = row_count;
  delete from public.route_defaults where upper(code) = v_code;

  return jsonb_build_object('code', v_code, 'name', v_name,
    'routes_deleted', v_routes, 'stops_deleted', v_stops, 'snapshot_id', v_snapshot);
end $function$;

-- Put a deleted route back exactly as it was (same ids, so photos/history that
-- reference stop ids survive an accidental delete + undo).
create or replace function public.restore_route(p_snapshot_id uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row public.deleted_routes%rowtype;
  v_routes int := 0;
  v_stops int := 0;
begin
  select * into v_row from public.deleted_routes where id = p_snapshot_id;
  if v_row.id is null then
    raise exception 'Nothing to restore — that deletion is no longer available.';
  end if;

  -- Catalog row (re-activate if a same-code row somehow exists again).
  if v_row.payload->'def' is not null and v_row.payload->'def' <> 'null'::jsonb then
    insert into public.route_defaults
      select * from jsonb_populate_record(null::public.route_defaults, v_row.payload->'def')
    on conflict (code) do update
      set name = excluded.name, color = excluded.color, active = true,
          sort = excluded.sort, driver_id = excluded.driver_id,
          business_line = excluded.business_line;
  end if;

  insert into public.routes
    select * from jsonb_populate_recordset(null::public.routes, coalesce(v_row.payload->'routes','[]'::jsonb))
  on conflict (id) do nothing;
  get diagnostics v_routes = row_count;

  insert into public.route_stops
    select * from jsonb_populate_recordset(null::public.route_stops, coalesce(v_row.payload->'stops','[]'::jsonb))
  on conflict (id) do nothing;
  get diagnostics v_stops = row_count;

  delete from public.deleted_routes where id = p_snapshot_id;

  return jsonb_build_object('code', v_row.code, 'name', v_row.name,
    'routes_restored', v_routes, 'stops_restored', v_stops);
end $function$;
