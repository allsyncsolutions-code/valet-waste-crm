-- 0051: Agent ask key (2026-08-31)
--
-- Bearer key for agent-mail's action=send — the ask endpoint that lets CLI
-- agents (ZCode / Kimi / Claude Code) file their AGENT-QUESTION email via one
-- curl from AGENTS.md instead of pausing for a human to relay it. The value
-- lives here in app_settings (never in the repo); the matching half lives in
-- ~/.valetwaste/agent-ask.key on David's Mac, referenced by path in AGENTS.md.
alter table public.app_settings
  add column if not exists agentmail_ask_key text;
