-- 0029: Who added each address.
-- properties.created_by records the person (Laura, Matt, Randy, …) or
-- "Trashy Randy" that added the address. A BEFORE INSERT trigger fills it from
-- the signed-in profile automatically, so every existing insert path (Clients
-- form, Import, one-off pickups) starts recording without code changes.
-- Service-role inserts (Randy's edge function) pass created_by explicitly.
alter table public.properties
  add column if not exists created_by text;

create or replace function public.set_property_creator()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.created_by is null then
    select coalesce(full_name, email) into new.created_by
      from public.profiles where id = auth.uid();
  end if;
  return new;
end $function$;

drop trigger if exists trg_property_creator on public.properties;
create trigger trg_property_creator
  before insert on public.properties
  for each row execute function public.set_property_creator();
