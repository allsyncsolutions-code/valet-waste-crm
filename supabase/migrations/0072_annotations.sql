/* =====================================================================
 * Annotations ("Report an issue") — staff file marked-up screenshots,
 * screen recordings and notes about bugs / ideas / confusion from any
 * screen of the CRM. Single-tenant: no workspaces — visibility is
 * admin/staff via profiles.role. Field techs and the customer portal
 * never see this table. Screenshots/recordings live in the public
 * `tickets` storage bucket on unguessable paths.
 * ===================================================================== */

create table if not exists public.issue_reports (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  creator_name text,
  creator_email text,
  screen text,                -- the nav view id they were on (e.g. "invoices")
  page_path text,             -- path + query at capture time
  title text not null,
  note text,
  target_label text,          -- pinned element's label (element-pin mode)
  selector text,              -- pinned element's best-effort CSS path
  screenshot_url text,        -- public tickets-bucket URL of the marked-up JPEG
  video_url text,             -- public tickets-bucket URL of the screen recording (webm/mp4)
  status text not null default 'new' check (status in ('new', 'handled')),
  created_at timestamptz not null default now()
);

-- History: replies + status changes are both rows here (kind 'reply' |
-- 'status'), chronological — nothing is ever deleted, that's the record.
create table if not exists public.issue_report_replies (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.issue_reports(id) on delete cascade,
  author uuid references auth.users(id) on delete set null,
  author_name text,
  body text not null,
  kind text not null default 'reply' check (kind in ('reply', 'status')),
  created_at timestamptz not null default now()
);

create index if not exists issue_report_replies_report_idx on public.issue_report_replies(report_id);

-- Staff gate, shared by both tables' policies (matches authData.isStaff).
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin', 'staff')
  )
$$;

alter table public.issue_reports enable row level security;
alter table public.issue_report_replies enable row level security;

-- Staff file annotations, always as themselves.
create policy "staff file annotations" on public.issue_reports
  for insert to authenticated
  with check (public.is_staff() and created_by = auth.uid());

-- Staff see every annotation (shared team inbox).
create policy "staff read annotations" on public.issue_reports
  for select to authenticated using (public.is_staff());

-- Staff update status (mark handled / reopen). History rows record who/when.
create policy "staff manage annotations" on public.issue_reports
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy "staff read annotation history" on public.issue_report_replies
  for select to authenticated using (public.is_staff());

create policy "staff write annotation history" on public.issue_report_replies
  for insert to authenticated
  with check (public.is_staff() and author = auth.uid());

-- Public bucket; unguessable random paths are the access control (kit posture).
insert into storage.buckets (id, name, public)
values ('tickets', 'tickets', true)
on conflict (id) do nothing;
