-- 0017: bulk_import_properties accepts MULTIPLE pickup days.
-- payload.pickup_days (jsonb array of day names) is preferred; the legacy
-- single payload.pickup_day still works, so Randy's bulk_add_properties tool
-- keeps functioning unchanged. Days are validated and ordered Mon→Sun.

create or replace function public.bulk_import_properties(payload jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_customer_id uuid;
  v_customer_name text := nullif(payload->>'customer_name','');
  v_default_service text := nullif(payload->>'default_service','');
  v_price numeric := nullif(payload->>'price','')::numeric;
  v_create_schedule boolean := coalesce((payload->>'create_schedule')::boolean, false);
  v_pickup_day text := coalesce(nullif(payload->>'pickup_day',''), 'monday');
  v_pickup_freq text := coalesce(nullif(payload->>'pickup_freq',''), 'weekly');
  v_needs_review boolean := coalesce((payload->>'needs_review')::boolean, false);
  v_all_days constant text[] := array['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  v_pickup_days text[];
  v_days text[];
  v_count int := 0;
  v_dupes int := 0;
begin
  -- Multi-day support: prefer pickup_days (array), fall back to pickup_day.
  select coalesce(array_agg(d order by array_position(v_all_days, d)), '{}'::text[])
    into v_pickup_days
  from (
    select distinct jsonb_array_elements_text(coalesce(payload->'pickup_days','[]'::jsonb)) as d
  ) s
  where d = any(v_all_days);
  if coalesce(array_length(v_pickup_days, 1), 0) = 0 then
    v_pickup_days := array[v_pickup_day];
  end if;

  v_days := case
              when v_create_schedule and v_pickup_freq <> 'on_call' then v_pickup_days
              else '{}'::text[]
            end;

  if coalesce(payload->>'customer_id','') <> '' then
    v_customer_id := (payload->>'customer_id')::uuid;
  elsif v_customer_name is not null then
    select id into v_customer_id from public.customers where name ilike v_customer_name limit 1;
    if v_customer_id is null then
      insert into public.customers(name, status) values (v_customer_name, 'active') returning id into v_customer_id;
    end if;
  else
    raise exception 'customer_id or customer_name is required';
  end if;

  -- How many incoming addresses already exist (normalized match) BEFORE inserting?
  select count(*) into v_dupes
  from jsonb_to_recordset(coalesce(payload->'properties','[]'::jsonb)) as p(address text)
  where public.norm_address(p.address) is not null
    and exists (
      select 1 from public.properties ex
      where public.norm_address(ex.address) = public.norm_address(p.address)
    );

  -- Batch-insert. A property is flagged needs_review if the import said so OR the
  -- address has no 5-digit ZIP (likely missing city/zip → unreliable geocoding).
  insert into public.properties (customer_id, code, name, address, service, notes, price, pickup_days, pickup_frequency, needs_review)
  select v_customer_id,
         nullif(p.code, ''),
         coalesce(nullif(p.name, ''), p.address),
         p.address,
         coalesce(nullif(p.service, ''), v_default_service),
         nullif(p.notes, ''),
         v_price,
         v_days,
         v_pickup_freq,
         (v_needs_review or coalesce(p.address,'') !~ '\y\d{5}\y')
  from jsonb_to_recordset(coalesce(payload->'properties', '[]'::jsonb))
       as p(code text, name text, address text, service text, notes text)
  where coalesce(nullif(p.address,''), nullif(p.name,'')) is not null;
  get diagnostics v_count = row_count;

  if v_create_schedule and not exists (select 1 from public.pickup_schedules where customer_id = v_customer_id) then
    insert into public.pickup_schedules(customer_id, frequency, day_of_week, service)
    values (v_customer_id, v_pickup_freq,
            case when v_pickup_freq = 'on_call' then null else v_pickup_days[1] end,
            v_default_service);
  end if;

  return jsonb_build_object('customer_id', v_customer_id, 'inserted', v_count, 'duplicates', v_dupes);
end $function$;
