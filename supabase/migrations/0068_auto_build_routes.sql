-- 0068: Auto-build the coming week's routes.
--
-- Automation row for the auto_build_week_routes runner in automations-run:
-- every morning (the existing 11:30 UTC cron) it looks 8 days ahead and, for
-- any (route code, date) that has no route yet but the code ran on that same
-- weekday in the last 6 weeks, creates the route and copies that source
-- route's stops — the manual "Copy last <weekday>" workflow, done
-- automatically. Paused properties and that day's skip overrides are
-- respected; routes that already exist are never touched, so manual edits
-- always win.
--
-- STAGED ONLY — apply with owner approval (AGENTS.md: schema/data changes).

insert into public.automations (kind, name, description, status, requested_by)
select 'auto_build_week_routes',
       'Auto-build the coming week''s routes',
       'Each morning: for the next 8 days, any route code that ran on that weekday in the last 6 weeks gets its route created (if missing) with last time''s stops copied over — pauses and skip-days respected. Existing routes are never touched, so manual edits always win. Randy texts the team a summary whenever something new gets built.',
       'enabled',
       'owner (2026-10-25 session request: "automatically bring all the stops from last week into this week")'
where not exists (select 1 from public.automations where kind = 'auto_build_week_routes');
