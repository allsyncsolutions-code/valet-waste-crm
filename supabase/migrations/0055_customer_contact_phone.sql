-- 0055 — Point-of-contact phone on customers.
--
-- Some accounts are reached through a different person than the number on
-- file (property manager, front desk, family member). When contact_phone is
-- set, every client-facing TEXT resolves to it first — visit notices
-- (on-my-way / arrival / complete), invoice texts + reminders, and Randy's
-- client texts. Empty/NULL keeps today's behavior: the main customers.phone.
-- Emails are unaffected (still customers.email).

alter table public.customers
  add column if not exists contact_phone text;
