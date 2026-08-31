# Agent Approval Workflow

## Required first step
Before making changes, read this file completely. Follow these instructions for this repository.

## Owner approval channel
For any decision that requires owner approval, send a structured email to:

`dev-agents@allsynccrm.com`

Do not make a high-impact decision merely because an implementation seems reasonable. Pause, send the required question, and wait for an explicit decision.

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

## Approval request format

### Email subject

```text
[AGENT-QUESTION][BLOCKING][Valet Waste][GitHub PR #NUMBER] Short decision title
```

If no pull request exists yet, use:

```text
[AGENT-QUESTION][BLOCKING][Valet Waste][GitHub Issue #NUMBER] Short decision title
```

### Email body

```text
AGENT-QUESTION v1
Question-ID: aq_YYYYMMDD_unique-id
Project: Valet Waste
Repository: allsyncsolutions-code/valet-waste-crm
Branch: BRANCH_NAME
Source: Claude Code
Return-Channel: github-pr-comment
Pull-Request: PR_NUMBER
Blocking: yes
Priority: high
Decision-Deadline: ISO-8601 timestamp with timezone

Summary:
One or two sentences explaining the situation.

Question:
State the exact decision needed from the owner.

Recommendation:
State the preferred option and why.

Alternatives:
A. First viable option.
B. Second viable option.
C. Third viable option, if applicable.

Impact:
Describe security, cost, data, customer, delivery, and rollback impact.

Relevant files:
List affected file paths and GitHub links if available.

Proposed next action:
State exactly what you will do after approval.
```

Replace every ALL-CAPS placeholder with the actual project details. Keep the email concise but complete. Set the email's `Reply-To` header to `dev-agents@allsynccrm.com` so the owner's reply returns to the approval mailbox no matter which address the question was sent from. Never include passwords, API keys, tokens, full `.env` files, or unnecessary customer personal data.

## Valid owner decisions
Only treat an answer as approval when it begins with one of these exact prefixes:

```text
APPROVE:
REJECT
CLARIFY
```

Examples:

```text
APPROVE: B
Decision: Use the staged database migration.
Constraints: Make it reversible, preserve existing records, add tests, and do not run it in production.
```

```text
REJECT
Decision: Do not add automatic SMS retries.
Next step: Build a staff-review queue instead.
```

```text
CLARIFY
Question: What is the expected daily message volume, and which provider errors are transient versus permanent?
```

Do not interpret "yes", "looks good", "go ahead", emoji reactions, or similar informal text as approval.

## After a decision

1. Wait for the owner's response.
2. Confirm the response matches the active Question-ID and linked GitHub issue or pull request.
3. Proceed only within the approved option and stated constraints.
4. If new facts change the risk, scope, cost, data impact, or security impact, stop and send a new question.
5. Record a concise implementation summary, changed files, validation steps, and test results in the associated GitHub pull request or issue.
6. Never merge, deploy, publish, change DNS, execute production migrations, or expose secrets solely because an email approval exists; request the specific approval required by the repository's release process.

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
