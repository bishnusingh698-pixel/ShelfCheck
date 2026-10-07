# ShelfCheck — Build Progress

Status: **Phase 0 in progress**

## Resume protocol
1. Read `PROGRESS.md` (this file), then `DECISIONS.md` (titles), then the current phase in `docs/SPEC.md`.
2. Run `git log --oneline -20` and `npm run verify`.
3. Continue from the first unfinished work packet.

## Current phase
Phase 0 — Plan and verify.

## Done
- Environment probed: Node v24.21.0, npm 11.19.1, network OK, no docker daemon, sudo available.
- PostgreSQL 17.11 installed locally (Debian apt), role `openhands` (superuser, password `openhands`), test DB `shelfcheck_test` created. Used for integration tests in place of Neon (Neon config still used in production paths).
- Platform facts researched and recorded in `docs/api-notes.md` (official sources; live introspection NOT possible without a dev store — marked unverified where applicable).
- Verified latest stable Admin API version: **2026-07** (2026-10 is release candidate).
- Verified official template of record: `Shopify/shopify-app-template-react-router` (React Router 7.18.x, React 18.3.1, Polaris web components, Prisma 6.19).
- `docs/SPEC.md`, `docs/plan.md`, `docs/api-notes.md` written.

## Next
- Phase 1: scaffold app from the verified template, add strict TS/ESLint/Vitest/Playwright/msw, scripts, Express entry, render.yaml. Gate: `npm run verify` green.

## Verify command
`npm run verify` (defined in Phase 1; until then `node --version` and `git log`).

## Known issues / rate-limit incidents
- None yet. (Model-request budget: target ≤30/min, batch tool calls.)
- Live checks (dev store, Neon, Resend, Telegram, cron) are impossible without credentials — all mapped to `HUMAN_STEPS.md`.
