# Agent Approval Workflow

## Required first step
Before making changes, read this file completely. Follow these instructions for this repository.

## Owner approval channel
**(Updated 2026-09-04, at the owner's direction: the email round-trip is PAUSED.)**
Ask for approvals **directly in the working session** — the owner works with agents here (desktop or phone remote). Do NOT send AGENT-QUESTION emails to `dev-agents@allsynccrm.com` and do NOT wait on PR-comment replies; the `agent-mail` edge function is dormant (kept deployed for reversibility — its reply-posting half never worked reliably anyway).

For any decision that requires owner approval: pause, ask the owner in the session, and wait for an explicit decision. If the owner is not reachable in the session, stop and leave the work clearly staged (branch pushed, PR open, summary written) rather than proceeding.

## Making the ask
Ask in the conversation, in one clear block:

- **Situation** — one or two sentences.
- **Decision needed** — the exact question, with options when there are real alternatives (A / B / C) and a recommendation.
- **Impact** — anything that touches production, customer communications, money, data, or secrets, plus rollback.

Keep it short enough to answer from a phone. If the answer changes the risk, scope, cost, data impact, or security impact, ask again — don't stretch an earlier approval to cover new ground.

Open a PR for anything non-trivial (`gh pr create`) and reference its number so the work is reviewable, but the approval itself comes from the owner in the session.

## Decisions that require approval
Request approval before doing any of the following:

- Creating, changing, applying, rolling back, or deleting database migrations, schemas, tables, columns, indexes, policies, backfills, retention rules, or user data.
- Changing authentication, authorization, user roles, permissions, tenant isolation, session handling, encryption, security controls, or privacy behavior.
- Using, changing, exposing, rotating, or requesting secrets, API keys, OAuth permissions, environment variables, DNS, domains, cloud infrastructure, or production configuration.
- Deploying to production, merging a pull request, publishing a mobile app, changing CI/CD, or enabling an external integration in production.
- Adding or changing paid services, subscriptions, payment behavior, billing logic, third-party API usage that may incur cost, quotas, or rate-limit behavior.
- Sending or changing customer-facing email, SMS, phone, push-notification, consent, opt-out, marketing, or messaging behavior.
- Introducing a breaking public API change, changing a major user workflow, or making a product/business decision not specified by the owner.
- Performing any action that can cause data loss, duplicated charges, duplicated messages, security exposure, compliance risk, or material customer impact.
- Modifying `AGENTS.md`, `CLAUDE.md`, or any other agent-instruction file in this repository. Agents may not rewrite their own guardrails; changes to this workflow itself always require owner approval.

## Work allowed without approval
You may proceed without asking for approval when the change is reversible and does not alter public behavior, security, data, cost, deployment, or customer communications. Examples:

- Formatting, comments, documentation, and README improvements.
- Adding or improving tests.
- Small internal refactors that preserve behavior and have passing tests.
- Local debugging and isolated bug fixes that do not change a public contract.
- Development-only configuration that does not contain secrets or alter production behavior.

If uncertain whether approval is required, treat the work as blocked and ask.

## Valid owner decisions
Only proceed when the owner gives an explicit, unambiguous go-ahead in the session. The cleanest forms:

- `APPROVE:` / `APPROVE: B` (option letter), or plainly worded equivalents such as "approved — merge it" or "yes, do option A".

Do NOT treat silence, "hm", "maybe later", or a tangent about something else as approval. When a message is ambiguous, confirm with one short question. Record the decision (quote it in the PR description or commit message when practical).

## After a decision
1. Confirm the response actually covers the work you're about to do (scope, option, constraints).
2. Proceed only within the approved option and stated constraints.
3. If new facts change the risk, scope, cost, data impact, or security impact, stop and ask again.
4. Record a concise implementation summary, changed files, validation steps, and test results in the associated pull request.
5. An approval to merge is not automatically an approval for follow-on production changes (e.g. a separately deployed edge function or a migration) — name each step in the ask, or ask again.

## Project-specific settings

```text
Project name: Valet Waste
Repository: allsyncsolutions-code/valet-waste-crm
Default branch: main
Primary stack: Vite 6 + React 18 (plain JSX frontend), Supabase (Postgres migrations + TypeScript Edge Functions), Leaflet
Test command: npm run build (no dedicated test suite exists; build success is the current verification step)
Build command: npm run build
Deployment environment: production (Vercel frontend + hosted Supabase project); no separate staging environment detected
```

### Repository-specific cautions

- Pushing to `main` triggers `.github/workflows/notify-push.yml`, which sends an SMS to Valet Waste admins via the `notify-push` Supabase edge function. Treat any push to `main` as a customer-facing communication event requiring owner approval.
- Database migrations live in `supabase/migrations/` and Edge Functions in `supabase/functions/`. Any change there falls under the "requires approval" list above.
- Frontend environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (read in `src/lib/supabaseClient.js`). Never commit `.env` files or secret values.
- Deploy edge functions from a worktree under `/Users` (never `/tmp`) with `--project-ref ozoonpwuyusvksmydkuu`; worktrees are not supabase-linked.
