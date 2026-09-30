-- Web Forms: staff-managed public signup forms (the Trashbolt-style page at
-- /?signup=<slug>). Each row is one shareable/embeddable form; `config` holds
-- everything the public page renders (intro, line items/pricing, terms).
-- The public edge function reads rows via service role (it enforces active +
-- field sanitization itself); direct table access is staff-only.

create table if not exists public.web_forms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists web_forms_slug_idx on public.web_forms(slug);

alter table public.web_forms enable row level security;
drop policy if exists staff_all_web_forms on public.web_forms;
create policy staff_all_web_forms on public.web_forms
  for all to authenticated using (is_staff()) with check (is_staff());

-- The form /?signup=1 (and the bare signup page) resolves to — keeps the
-- already-published default link working. Pricing: $15/wk for 1 pickup,
-- $25/wk for 2 (weekly service only; On-Demand = on_call, priced per job).
insert into public.web_forms (name, slug, active, config, created_by) values
 ('Standard signup', 'default', true,
  '{"intro": null,
    "line_items": [],
    "total_label": null,
    "pricing": {"one_pickup": 15, "two_pickup": 25,
                "on_demand_note": "Varies by location and date requested — we''ll reach out after you submit."},
    "terms": "By tapping Approve you agree to start valet trash service at the address above on the schedule shown, to monthly billing, and — if you saved a card — that it may be charged for service. We’ll text you to confirm your exact start date before your first visit."}'::jsonb,
  'system');
