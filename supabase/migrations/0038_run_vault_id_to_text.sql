-- 0038: run_vault_id was created as integer, but Run's /charge returns
-- vault_id as a UUID string, so every card-save PATCH failed with
-- 22P02 and (pre-fix) was silently swallowed. Widen to text.
alter table customers alter column run_vault_id type text using run_vault_id::text;
