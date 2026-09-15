-- 0059: photos on portal requests. Clients can attach up to 4 pictures of
-- what needs picking up (junk removal etc.); the portal fn decodes them,
-- uploads to the public stop-photos bucket under requests/<date>/<uuid>.<ext>
-- and stores the storage paths here. jsonb array of text paths; '[]' default.
alter table public.portal_requests
  add column if not exists photos jsonb not null default '[]'::jsonb;
