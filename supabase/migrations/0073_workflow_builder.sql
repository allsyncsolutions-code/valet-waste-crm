-- =====================================================================
-- Workflow builder / automation studio (ported from AllSync export, 2026-11-11)
-- ---------------------------------------------------------------------
-- Brings AllSync's GHL-style workflow builder to Valet Waste:
--   automation_rules   — builder-saved workflows (trigger + result + actions[])
--   automation_sends   — delivery ledger (times-run counters + exactly-once)
--   automation_folders — workflow groups
--   save_automation_rule / set_automation_rule_folder — the ONLY write paths
--     (security definer RPCs; direct table insert/update stay revoked)
--
-- VW adaptations vs the AllSync originals:
--   · Single-tenant: no workspaces table. workspace_id is kept as a column
--     (sentinel default) so the ported UI/worker code keeps its shape; the
--     RPCs ignore the passed value.
--   · RLS/membership: workspace_members predicates → public.is_staff() for
--     read, a new public.is_admin() (profiles.role = 'admin') for manage.
--   · The trigger/result FIXED menu is verbatim AllSync for now; PR 2 prunes
--     irrelevant entries (deals/pipelines) and adds VW triggers
--     (invoice_declined, chargeback_detected) with a re-run of this RPC.
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------- shared admin gate (read gate is_existing public.is_staff) ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  )
$$;

-- ---------- automation_rules ----------
create table if not exists public.automation_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default '00000000-0000-0000-0000-000000000001',
  name         text not null default 'New workflow',
  enabled      boolean not null default true,
  classification text,
  is_template  boolean not null default false,
  trigger      jsonb not null default '{}'::jsonb,
  result       jsonb not null default '{}'::jsonb,   -- legacy single action
  actions      jsonb not null default '[]'::jsonb,   -- multi-action steps (02)
  folder_id    uuid,                                 -- groups (03)
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_automation_rules_ws
  on public.automation_rules(workspace_id, enabled);
create index if not exists idx_automation_rules_trigger
  on public.automation_rules(workspace_id, ((trigger ->> 'type')))
  where enabled;
create index if not exists automation_rules_folder_idx
  on public.automation_rules(folder_id);

comment on column public.automation_rules.actions is
  'GHL-style multi-step workflows: jsonb array of result-shaped action steps, executed in order after result. Empty array = the classic single-result rule.';

alter table public.automation_rules enable row level security;

-- Staff read; INSERT/UPDATE stay revoked by design — save_automation_rule
-- (below) is the only write path so the server validates shapes.
drop policy if exists automation_rules_staff_read on public.automation_rules;
create policy automation_rules_staff_read on public.automation_rules
  for select to authenticated using (public.is_staff());

-- Deletes go through the client (admin only).
drop policy if exists automation_rules_admin_delete on public.automation_rules;
create policy automation_rules_admin_delete on public.automation_rules
  for delete to authenticated using (public.is_admin());

grant select, delete on public.automation_rules to authenticated;

-- ---------- automation_sends: delivery ledger ----------
-- Written ONLY by the executor (service role). Staff read so the Workflows
-- list can show how many times each rule ran.
create table if not exists public.automation_sends (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null default '00000000-0000-0000-0000-000000000001',
  automation_key text not null,          -- 'rule:<id>' for builder workflows
  subject_type   text,
  subject_id     uuid,
  slot           text not null default '',
  channel        text not null default '',
  recipient      text,
  status         text not null default 'sent',
  error          text,
  created_at     timestamptz not null default now()
);

-- Deduplication: one send per (rule, subject, slot, channel) — the executor
-- relies on this unique index for exactly-once semantics.
create unique index if not exists automation_sends_once
  on public.automation_sends(workspace_id, automation_key, subject_id, slot, channel);
create index if not exists automation_sends_ws_time
  on public.automation_sends(workspace_id, created_at desc);

alter table public.automation_sends enable row level security;

drop policy if exists automation_sends_staff_read on public.automation_sends;
create policy automation_sends_staff_read on public.automation_sends
  for select to authenticated using (public.is_staff());

grant select on public.automation_sends to authenticated;

-- ---------- automation_folders: workflow groups ----------
create table if not exists public.automation_folders (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default '00000000-0000-0000-0000-000000000001',
  name         text not null,
  position     integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists automation_folders_ws_idx
  on public.automation_folders(workspace_id, position, created_at);

alter table public.automation_folders enable row level security;

drop policy if exists automation_folders_staff_read on public.automation_folders;
create policy automation_folders_staff_read on public.automation_folders
  for select to authenticated using (public.is_staff());
drop policy if exists automation_folders_admin_insert on public.automation_folders;
create policy automation_folders_admin_insert on public.automation_folders
  for insert to authenticated with check (public.is_admin());
drop policy if exists automation_folders_admin_update on public.automation_folders;
create policy automation_folders_admin_update on public.automation_folders
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists automation_folders_admin_delete on public.automation_folders;
create policy automation_folders_admin_delete on public.automation_folders
  for delete to authenticated using (public.is_admin());

grant select, insert, update, delete on public.automation_folders to authenticated;

-- on delete set null: deleting a group un-groups its workflows.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'automation_rules_folder_fkey'
  ) then
    alter table public.automation_rules
      add constraint automation_rules_folder_fkey
      foreign key (folder_id) references public.automation_folders(id) on delete set null;
  end if;
end $$;

comment on column public.automation_rules.folder_id is
  'Automation group (GHL folder). Nullable — ungrouped rules are null. Assigned only via set_automation_rule_folder.';

-- ---------- save_automation_rule: the builder's ONLY save path ----------
-- The FIXED menu mirrors the UI's TRIGGER_TYPES / RESULT_TYPES and the
-- SUPPORTED_* sets in the executor. KEEP IN SYNC (PR 2 prunes/adds).
create or replace function public.save_automation_rule(
  p_workspace_id uuid,
  p_id           uuid,
  p_name         text,
  p_trigger      jsonb,
  p_result       jsonb,
  p_enabled      boolean default true,
  p_actions      jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.automation_rules%rowtype;
  v_tt    text;
  v_rt    text;
  v_name  text;
  v_step  jsonb;
  v_idx   integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_admin() then
    raise exception 'admin access required to save automations';
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'name required';
  end if;
  if p_trigger is null or p_result is null then
    raise exception 'trigger and result required';
  end if;
  if p_actions is null then
    p_actions := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_actions) <> 'array' then
    raise exception 'actions must be an array';
  end if;
  if jsonb_array_length(p_actions) > 10 then
    raise exception 'a workflow can have at most 10 actions';
  end if;
  -- Payload sanity: rules are small JSON, not documents.
  if length(p_trigger::text) + length(p_result::text) + length(p_actions::text) > 30000 then
    raise exception 'automation rule payload too large (30k character limit)';
  end if;

  v_tt := p_trigger->>'type';
  if v_tt not in (
    'lead_created', 'email_classified_as_lead', 'event_created', 'event_starts_in',
    'event_completed', 'invoice_unpaid_for', 'deal_stage_changed', 'deal_created',
    'property_status_changed', 'date_field_offset', 'deal_stale_in_stage'
  ) then
    raise exception 'unsupported trigger type "%"', coalesce(v_tt, '');
  end if;
  v_rt := p_result->>'type';
  if v_rt not in (
    'notify_team', 'notify_agent', 'notify_members', 'text_customer', 'email_customer',
    'create_task', 'move_deal', 'set_deal_field', 'add_tag'
  ) then
    raise exception 'unsupported result type "%"', coalesce(v_rt, '');
  end if;

  -- Per-type required parameters (the engine reads these — a rule saved
  -- without them can never match, so it's refused here instead).
  if v_tt = 'deal_stage_changed' and coalesce(p_trigger->>'to_stage', '') = '' then
    raise exception 'deal_stage_changed requires to_stage';
  end if;
  if v_tt = 'deal_stale_in_stage' and (coalesce(p_trigger->>'stage', '') = ''
       or (coalesce(p_trigger->>'days', '') = '' and coalesce(p_trigger->>'minutes', '') = '')) then
    raise exception 'deal_stale_in_stage requires stage and days (or minutes)';
  end if;
  if v_tt = 'date_field_offset' and coalesce(p_trigger->>'field', '') = '' then
    raise exception 'date_field_offset requires field';
  end if;
  if v_tt = 'event_starts_in' and (coalesce(p_trigger->>'value', '') = ''
       or coalesce(p_trigger->>'unit', '') not in ('minutes', 'hours', 'days')) then
    raise exception 'event_starts_in requires value and unit (minutes, hours or days)';
  end if;
  if v_tt = 'invoice_unpaid_for' and coalesce(p_trigger->>'days', '') = '' then
    raise exception 'invoice_unpaid_for requires days';
  end if;

  -- The SAME per-type validation runs for the primary result and for every
  -- action step — an action missing its engine-required field is refused
  -- here exactly like a bad result.
  v_idx := -1;
  foreach v_step in array coalesce(
    (select array_agg(x) from jsonb_array_elements(p_actions) x),
    '{}'::jsonb[]
  ) loop
    v_idx := v_idx + 1;
    v_rt := v_step->>'type';
    if v_rt not in (
      'notify_team', 'notify_agent', 'notify_members', 'text_customer', 'email_customer',
      'create_task', 'move_deal', 'set_deal_field', 'add_tag'
    ) then
      raise exception 'unsupported action type "%" (action %)', coalesce(v_rt, ''), v_idx + 1;
    end if;
    if v_rt = 'move_deal' and coalesce(v_step->>'to_stage', '') = '' then
      raise exception 'move_deal (action %) requires to_stage', v_idx + 1;
    end if;
    if v_rt = 'set_deal_field' and coalesce(v_step->>'field', '') = '' then
      raise exception 'set_deal_field (action %) requires field', v_idx + 1;
    end if;
    if v_rt = 'add_tag' and coalesce(v_step->>'tag', '') = '' then
      raise exception 'add_tag (action %) requires tag', v_idx + 1;
    end if;
    if v_rt = 'text_customer' and coalesce(v_step->>'message_template', '') = '' then
      raise exception 'text_customer (action %) requires message_template', v_idx + 1;
    end if;
    if v_rt = 'email_customer' and coalesce(v_step->>'body_template', '') = '' then
      raise exception 'email_customer (action %) requires body_template', v_idx + 1;
    end if;
    if v_rt = 'create_task' and coalesce(v_step->>'title_template', '') = ''
         and (jsonb_typeof(v_step->'checklist') <> 'array' or jsonb_array_length(v_step->'checklist') = 0) then
      raise exception 'create_task (action %) requires title_template or a non-empty checklist', v_idx + 1;
    end if;
    if v_rt = 'notify_members' then
      if coalesce(v_step->>'audience', '') not in ('everyone', 'managers', 'selected') then
        raise exception 'notify_members (action %) requires audience of everyone, managers or selected', v_idx + 1;
      end if;
      if v_step->>'audience' = 'selected'
         and (jsonb_typeof(v_step->'member_ids') <> 'array' or jsonb_array_length(v_step->'member_ids') = 0) then
        raise exception 'notify_members audience selected (action %) requires a non-empty member_ids list', v_idx + 1;
      end if;
    end if;
  end loop;

  if p_id is null then
    insert into public.automation_rules (workspace_id, name, enabled, trigger, result, actions, created_by)
    values ('00000000-0000-0000-0000-000000000001', v_name, coalesce(p_enabled, true), p_trigger, p_result, p_actions, 'admin')
    returning * into v_row;
  else
    update public.automation_rules
       set name = v_name,
           enabled = coalesce(p_enabled, true),
           trigger = p_trigger,
           result = p_result,
           actions = p_actions,
           updated_at = now()
     where id = p_id
     returning * into v_row;
    if not found then
      raise exception 'automation rule not found';
    end if;
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke execute on function public.save_automation_rule(uuid, uuid, text, jsonb, jsonb, boolean, jsonb) from public, anon;
grant  execute on function public.save_automation_rule(uuid, uuid, text, jsonb, jsonb, boolean, jsonb) to authenticated;

-- ---------- set_automation_rule_folder ----------
create or replace function public.set_automation_rule_folder(
  p_rule_id   uuid,
  p_folder_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_admin() then
    raise exception 'admin access required to manage automations';
  end if;

  if not exists (select 1 from public.automation_rules where id = p_rule_id) then
    raise exception 'automation rule not found';
  end if;

  if p_folder_id is not null then
    if not exists (select 1 from public.automation_folders f where f.id = p_folder_id) then
      raise exception 'folder not found';
    end if;
  end if;

  update public.automation_rules
     set folder_id = p_folder_id,
         updated_at = now()
   where id = p_rule_id;
end;
$$;

revoke execute on function public.set_automation_rule_folder(uuid, uuid) from public, anon;
grant  execute on function public.set_automation_rule_folder(uuid, uuid) to authenticated;
