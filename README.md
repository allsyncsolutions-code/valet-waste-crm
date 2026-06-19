# Valet Waste — Dispatch CRM (AllSync CRM)

A waste-hauler dispatch CRM built from a [Claude Design](https://claude.ai/design) handoff bundle. Single-page app — no backend, realistic placeholder data only.

## Stack
- Vite 6 + React 18 (plain JSX)
- Inline-styled, faithful to the design comp; IBM Plex Sans / Mono
- Fully responsive (desktop rail → mobile drawer + bottom nav; AI dock → bottom sheet)

## Views
Dashboard · Routes & Dispatch · Recurring Schedules · Invoicing · Clients (with managed-property drawer) · Drivers & Field · Client Portal · Team — plus the **Trashy Randy** AI dock.

The AI dock calls `window.claude.complete` when available and falls back to canned operational replies otherwise (so it works fully offline on Vercel).

## Develop
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
npm run preview
```
