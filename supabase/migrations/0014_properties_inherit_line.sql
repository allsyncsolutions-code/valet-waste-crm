-- Properties always belong to their client's business line — applied 2026-07-03.
update public.properties p
set business_line = c.business_line
from public.customers c
where p.customer_id = c.id and p.business_line is distinct from c.business_line;

create or replace function public.property_inherit_line()
returns trigger
language plpgsql
as $$
begin
  if new.customer_id is not null then
    select business_line into new.business_line from public.customers where id = new.customer_id;
  end if;
  return new;
end;
$$;
drop trigger if exists property_inherit_line_trg on public.properties;
create trigger property_inherit_line_trg
  before insert on public.properties
  for each row execute function public.property_inherit_line();

create or replace function public.customer_line_sync()
returns trigger
language plpgsql
as $$
begin
  if new.business_line is distinct from old.business_line then
    update public.properties set business_line = new.business_line where customer_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists customer_line_sync_trg on public.customers;
create trigger customer_line_sync_trg
  after update on public.customers
  for each row execute function public.customer_line_sync();
