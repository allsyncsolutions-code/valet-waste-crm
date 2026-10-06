-- 0066: bulk_import_properties v4 — actually SKIP normalized duplicates.
-- v3 (0030) counted payload rows matching an existing property (norm_address)
-- but inserted everything anyway, so Randy's bulk_add_properties and the
-- Import view both re-created addresses already on file ("duplicates" was a
-- count, not a filter — Randy reported N duplicates he'd just created).
-- v4: exact normalized matches against existing properties are skipped, and
-- identical rows within the same payload are collapsed (distinct on norm).
-- The returned `duplicates` count is unchanged in meaning: incoming rows that
-- already exist. Properties with a genuinely moved client are handled by the
-- existing merge/pause tools, not by double-entry.
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
  v_billing_type text := nullif(payload->>'billing_type','');
  v_created_by text := nullif(payload->>'created_by','');
  v_all_days constant text[] := array['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  v_pickup_days text[];
  v_days text[];
  v_count int := 0;
  v_dupes int := 0;
begin
  if v_billing_type is not null and v_billing_type not in ('subscription','one_time') then
    raise exception 'billing_type must be subscription or one_time';
  end if;

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
    if v_billing_type is not null then
      update public.customers set billing_type = v_billing_type where id = v_customer_id;
    end if;
  elsif v_customer_name is not null then
    select id into v_customer_id from public.customers where name ilike v_customer_name limit 1;
    if v_customer_id is null then
      insert into public.customers(name, status, billing_type)
      values (v_customer_name, 'active', coalesce(v_billing_type, 'subscription'))
      returning id into v_customer_id;
    elsif v_billing_type is not null then
      update public.customers set billing_type = v_billing_type where id = v_customer_id;
    end if;
  else
    raise exception 'customer_id or customer_name is required';
  end if;

  -- How many incoming addresses already exist (normalized match)? These are
  -- now SKIPPED by the insert below, not inserted again.
  select count(*) into v_dupes
  from jsonb_to_recordset(coalesce(payload->'properties','[]'::jsonb)) as p(address text)
  where public.norm_address(p.address) is not null
    and exists (
      select 1 from public.properties ex
      where public.norm_address(ex.address) = public.norm_address(p.address)
    );

  -- Batch-insert. Per-property "days" array (validated) beats the batch days.
  -- v4: distinct on normalized address within the payload (identical rows
  -- collapse to one) and NOT EXISTS against properties (already-on-file
  -- addresses are skipped, counted above as v_dupes).
  insert into public.properties (customer_id, code, name, address, service, notes, price, pickup_days, pickup_frequency, needs_review, created_by)
  select v_customer_id,
         nullif(p.code, ''),
         coalesce(nullif(p.name, ''), p.address),
         p.address,
         coalesce(nullif(p.service, ''), v_default_service),
         nullif(p.notes, ''),
         v_price,
         coalesce(
           (select array_agg(d order by array_position(v_all_days, d))
              from (select distinct jsonb_array_elements_text(p.days) as d) pd
             where d = any(v_all_days)),
           v_days),
         v_pickup_freq,
         (v_needs_review or coalesce(p.address,'') !~ '\y\d{5}\y'),
         v_created_by
  from (
    select distinct on (public.norm_address(coalesce(nullif(p2.address,''), p2.name))) p2.*
    from jsonb_to_recordset(coalesce(payload->'properties', '[]'::jsonb))
         as p2(code text, name text, address text, service text, notes text, days jsonb)
    where coalesce(nullif(p2.address,''), nullif(p2.name,'')) is not null
    order by public.norm_address(coalesce(nullif(p2.address,''), p2.name))
  ) p
  where not exists (
    select 1 from public.properties ex
    where public.norm_address(ex.address) = public.norm_address(coalesce(nullif(p.address,''), p.name))
  );
  get diagnostics v_count = row_count;

  if v_create_schedule and not exists (select 1 from public.pickup_schedules where customer_id = v_customer_id) then
    insert into public.pickup_schedules(customer_id, frequency, day_of_week, service)
    values (v_customer_id, v_pickup_freq,
            case when v_pickup_freq = 'on_call' then null else v_pickup_days[1] end,
            v_default_service);
  end if;

  return jsonb_build_object('customer_id', v_customer_id, 'inserted', v_count, 'duplicates', v_dupes);
end $function$;

-- Backstop trigger: a same-client exact-normalized duplicate can never be
-- INSERTed, no matter which app path sent it (CRM add-address form, portal
-- request approval, future tools, direct SQL). Frontend code also pre-checks
-- for a friendly message; this is the guarantee. Deliberately same-client
-- only: signup flows create a NEW customer (allowed — new tenant at a served
-- address), and the rare legitimate cross-client copy stays possible via the
-- CRM UI, where the duplicate scanner will surface it for review.
create or replace function public.properties_reject_same_client_dupe()
returns trigger
language plpgsql
as $function$
begin
  if new.customer_id is not null and nullif(new.address, '') is not null then
    if exists (
      select 1 from public.properties ex
      where ex.customer_id = new.customer_id
        and public.norm_address(ex.address) = public.norm_address(new.address)
    ) then
      raise exception 'Duplicate address: "%" already exists on this client (normalized match). Edit the existing address instead.', new.address;
    end if;
  end if;
  return new;
end $function$;

drop trigger if exists properties_reject_same_client_dupe on public.properties;
create trigger properties_reject_same_client_dupe
  before insert on public.properties
  for each row execute function public.properties_reject_same_client_dupe();
