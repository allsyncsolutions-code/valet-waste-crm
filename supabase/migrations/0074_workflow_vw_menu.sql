-- =====================================================================
-- Workflow builder — Valet Waste trigger/action menu + enable toggle
-- (2026-11-11, stage 2 of the studio port)
-- ---------------------------------------------------------------------
-- Replaces the verbatim-AllSync FIXED menu in save_automation_rule with the
-- Valet Waste menu the studio UI offers (src/views/Workflows.jsx — KEEP IN
-- SYNC), and adds set_automation_enabled for the list-row Publish toggle.
-- Idempotent.
-- =====================================================================

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

  -- The VW FIXED menu — mirrors WORKFLOW_TRIGGERS / ACTION_MENU in
  -- src/views/Workflows.jsx and the SUPPORTED_* sets in the automations-run
  -- worker (stage 3). KEEP IN SYNC.
  v_tt := p_trigger->>'type';
  if v_tt not in (
    'invoice_unpaid_for', 'invoice_declined', 'chargeback_detected', 'payment_received',
    'estimate_sent', 'estimate_viewed', 'estimate_accepted', 'estimate_unanswered_for'
  ) then
    raise exception 'unsupported trigger type "%"', coalesce(v_tt, '');
  end if;
  v_rt := p_result->>'type';
  if v_rt not in (
    'notify_team', 'notify_members', 'text_customer', 'email_customer'
  ) then
    raise exception 'unsupported result type "%"', coalesce(v_rt, '');
  end if;

  -- Per-type required parameters (the engine reads these — a rule saved
  -- without them can never match, so it's refused here instead).
  if v_tt in ('invoice_unpaid_for', 'estimate_unanswered_for')
     and coalesce(p_trigger->>'days', '') = '' then
    raise exception '% requires days', v_tt;
  end if;

  -- The SAME per-type validation runs for the primary result and for every
  -- action step.
  v_idx := -1;
  foreach v_step in array coalesce(
    (select array_agg(x) from jsonb_array_elements(p_actions) x),
    '{}'::jsonb[]
  ) loop
    v_idx := v_idx + 1;
    v_rt := v_step->>'type';
    if v_rt not in (
      'notify_team', 'notify_members', 'text_customer', 'email_customer'
    ) then
      raise exception 'unsupported action type "%" (action %)', coalesce(v_rt, ''), v_idx + 1;
    end if;
    if v_rt = 'text_customer' and coalesce(v_step->>'message_template', '') = '' then
      raise exception 'text_customer (action %) requires message_template', v_idx + 1;
    end if;
    if v_rt = 'email_customer' and coalesce(v_step->>'body_template', '') = '' then
      raise exception 'email_customer (action %) requires body_template', v_idx + 1;
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

-- Publish/Draft toggle for the workflow list — same admin bar as save.
create or replace function public.set_automation_enabled(
  p_id      uuid,
  p_enabled boolean
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

  update public.automation_rules
     set enabled = coalesce(p_enabled, true),
         updated_at = now()
   where id = p_id;
  if not found then
    raise exception 'automation rule not found';
  end if;
end;
$$;

revoke execute on function public.set_automation_enabled(uuid, boolean) from public, anon;
grant  execute on function public.set_automation_enabled(uuid, boolean) to authenticated;
