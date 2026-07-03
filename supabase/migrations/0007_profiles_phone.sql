-- Phone numbers on staff profiles so Randy's send_sms tool can text team
-- members by name — applied 2026-07-02
alter table public.profiles add column if not exists phone text;
