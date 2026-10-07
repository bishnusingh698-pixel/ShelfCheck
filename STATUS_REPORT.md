# ShelfCheck — Status Report (2026-10-07)

## Summary

ShelfCheck is an admin-only Shopify app that audits catalogs for data rot (duplicate SKUs, bad barcodes, missing weights/costs, zero-inventory published products) and turns them into a clickable punch list. The core engine is complete and verified: Prisma schema with reversible migrations, encrypting session storage, the bulk-operation scan pipeline with bounded-memory JSONL streaming, ten detectors with exact seeded-catalog counts, the issue lifecycle (snooze/ignore/intentional/resolved), a Postgres job queue with SKIP LOCKED, and a self-contained ICU i18n engine. This session finished the Phase 3 security work (tokens encrypted at rest, Admin API pinned to 2026-07) and re-verified the whole gate green (`npm run verify`, exit 0). What remains is the merchant-facing surface: webhook intake/sync handlers, all admin routes and UI, Resend/Telegram notifications, ten locale translations, and hardening.

## Done

Each item was verified by running the command shown; nothing here is from memory alone.

- **Phase 0 — plan and verified API facts** (commit `47c9b1b`). `docs/SPEC.md` (spec verbatim), `docs/plan.md`, `docs/api-notes.md` (Admin API 2026-07, bulk-operation rules, Neon/PgBouncer, Resend, Telegram, Partner Dashboard limits), `DECISIONS.md` D-1…D-25, `HUMAN_STEPS.md` (11 steps). Verified by reading the files; API facts are sourced from official docs listed in `docs/api-notes.md` — live introspection is deferred (no dev-store credentials; `scripts/verify-api.ts` exists for when they exist).
- **Phases 1-2 — scaffold, data layer, core security** (commit `705267f`). Prisma schema (11 models), migration `20261007082509_init` with hand-written `down.sql`; **up → down → up verified** against real Postgres; partial unique indexes verified live (one-active-scan-per-shop, pending-job dedupe, open-issue). Core lib: env (zod), db (cold-start retry), logger (redaction), crypto (AES-256-GCM + key versioning), timing-safe HMAC, rate-limit, transaction-scoped advisory locks, admin-graphql (THROTTLED backoff). Verified by `npm run verify` (typecheck + tests green at commit time).
- **Phases 3-6 — scan engine, detectors, lifecycle, jobs, i18n engine** (commit `cfe4162`). Bulk query + operation client, JSONL schema/streaming, orchestrator, reconcile; detectors (GS1 mod-10, barcode hints, row rules, duplicates in SQL); issue lifecycle incl. intentional-regrowth; job queue (SKIP LOCKED, dedupe, backoff, reclaim, watchdog), idempotent tick, scheduler in shop TZ; i18n engine + `locales/en.json` (218 keys) + generated `en-XA`. Verified in this session's re-run: 57 unit + 28 integration tests pass, and the 50,000-variant memory test peaked at **RSS 267 MB < 300 MB budget**.
- **Encrypting session storage** (commit `ef044af`, this session). `app/lib/session-storage.server.ts` seals access/refresh tokens with AES-256-GCM at rest; plaintext legacy rows keep loading; tampered values fail closed. Verified by `tests/integration/session-storage.test.ts` — 8/8 green (encryption at rest, round-trip, no caller mutation, legacy fallback, tamper tolerance, key-version rejection, no key material in ciphertext, find/delete).
- **Admin API version pin** (commit `ef044af`). `app/shopify.server.ts` now uses `ADMIN_API_VERSION` ("2026-07", verified equal to `ApiVersion.July26` in the installed `@shopify/shopify-api` types) instead of the template's October25. Verified via grep of `dist/ts/lib/types.d.ts` and `npm run verify` typecheck.
- **Full gate re-run, green** (this session, after the sandbox reset): `npm run verify` → **exit 0**: i18n:check 0 errors/10 warnings (only the ten missing locale files), typecheck clean, lint clean, 57 unit + 28 integration passed, secrets:check clean (104 tracked files). Note: the sandbox reset wiped the apt-installed Postgres; it was reinstalled, the role/db recreated, and the migration re-deployed before this run (`PROGRESS.md` now documents this).

## Half-done

- **Phase 3 webhook layer** — `app/webhooks/` is **empty**; only two webhook route files exist (`app/routes/webhooks.app.uninstalled.tsx`, `webhooks.app.scopes_update.tsx`, from the template). What exists: job queue + handler types ready to receive webhook events; the `webhook_events` table and dedupe column exist in the schema. What is missing: `intake.server.ts` (HMAC verify → dedupe on `X-Shopify-Webhook-Id` → persist → enqueue → 200), `uninstall.server.ts`, `redact.server.ts`, `product-sync.server.ts`, `inventory-sync.server.ts`, and the route files for products/inventory/bulk-ops/subscriptions/compliance. Next step: finish verifying that the library's `authenticate.webhook` compares HMAC on the raw body (was mid-verification at `node_modules/@shopify/shopify-app-react-router/dist/cjs/server/authenticate/webhooks/authenticate.js`), then write `intake.server.ts` first and its integration tests (valid/invalid/replayed HMAC).
- **Phase reports** — only `docs/phase-reports/phase-0.md` exists. Phases 1-6 were built and committed but their reports were never written (spec requires one per phase). Next step: write `phase-1.md`…`phase-6.md` retroactively from the commit history and DECISIONS entries (S effort each).
- **E2E test harness** — Playwright, `@axe-core/playwright`, and msw are installed as devDependencies, but there is **no `playwright.config.ts` and no `tests/e2e/` specs**, and `npm run verify` does not include `test:e2e`. `npm run test:e2e` would currently fail ("no config"). Next step: add `playwright.config.ts` + UI harness (`app/lib/ui-harness.server.ts` is also not yet written) and one smoke spec per screen.
- **Billing** — `app/billing/plans.ts` and `gating.ts` exist and are pure and unit-tested (`tests/unit/pure-logic.test.ts` covers canScanNow/issueVisibilityLimit/variantCap/featureEnabled/csvExportRows). Missing: `subscription.server.ts` (reads `currentAppInstallation.activeSubscriptions`, 5-minute cache) and the `app_subscriptions/update` webhook route.
- **Notifications** — `app/notifications/digest.server.ts` exists (selection logic); missing the Resend client, send budget, unsubscribe tokens, Telegram client/link, and their routes.
- **Locales** — `en.json` (218 keys) and generated `en-XA` only; the other ten locales are open (i18n:check warns). `i18n/GLOSSARY.md` and `listing/` are empty directories.

## Remaining (priority order)

1. **Phase 3 finish: webhook intake + uninstall/redact + compliance routes + their tests** — M. (Blocks Phase 7 watchers and acceptances 6/8/9.)
2. **Phase 7: watchers + auto-tag** (`product-sync`, `inventory-sync`, `autotag` with fingerprint loop-protection; acceptances 2/3/7/9 [AUTO]) — M.
3. **Phases 8-9: all admin routes and UI** (dashboard, issues + detail, rules, settings, plans, CSV export, scan action; ~14 missing route files, ~15 components; UI harness for Playwright; acceptances 4/5/10 [AUTO]) — L.
4. **Phase 10-11: Resend digest + Telegram** (clients, budgets, unsubscribe, bounce display, connect flow; acceptance 11 [AUTO]) — M.
5. **Phase 12: localization** — glossary, ten translations, TRANSLATION_REVIEW.md, `listing/*.md` — L.
6. **Phase 13: hardening** — phase reports 1-6, e2e + axe wiring, performance pass, README/PRIVACY_POLICY/SUBMISSION_CHECKLIST, `scripts/live-acceptance.ts`, final acceptance report — M/L.
7. **Deferred to a human** — every [LIVE] check (dev-store install/scan, real Resend/Telegram delivery, web vitals) is already broken down in `HUMAN_STEPS.md` (11 steps) with exact instructions and expected results.

## Low confidence

- **`authenticate.webhook` HMAC behavior** — I had not finished reading the library's implementation when this session ended. The plan assumes it verifies HMAC on the raw body (template default); if not, `intake.server.ts` will verify manually with `timing-safe.server`. Reading the installed source (or one integration test with a signed body) will settle it.
- **2026-07 Admin API field list in `docs/api-notes.md`** — verified against official docs, not live introspection; `scripts/verify-api.ts` (which asserts every field against a real schema) has never been run because there is no dev-store token. If a field is wrong, it is isolated behind `app/scan/bulk-query.ts` (one constant) per D-4.
- **Translations** — none written yet beyond en/en-XA, so "all locales pass" is untested by definition until Phase 12.
- **Billing/subscription mapping** — plan gating is pure and tested, but the `activeSubscriptions` → plan mapping (`subscription.server.ts`) is unwritten, so the end-to-end plan behavior (downgrade lock, upgrade unlock) is untested.
- **UI in an embedded iframe** — no routes beyond the template shell render today, so App Bridge embedding, CSP frame-ancestors per shop, and Polaris web components are completely unexercised.
- **Keys** — the dev `.env` keys are regenerated dev values (D-28); production key generation is documented but only exercised in dev/test.

## Blockers and questions

- **No external credentials exist in this environment** (dev store, Shopify app secrets, Neon, Resend, Telegram bot, cron-job.org). All [LIVE] acceptance checks are therefore prepared, not run — see `HUMAN_STEPS.md`. No action needed unless you want those checks executed; they need a Partner Dashboard app + dev store.
- **No git remote existed for this repo** — I created a private GitHub repo under the authenticated account and pushed `master` (the project history) plus this branch. No secrets were committed: `secrets:check` passes and `.env` is gitignored (only `.env.example` is tracked).
- **A fine-grained GitHub PAT was pasted into the chat** — I did not use, store, or commit it (the preconfigured `GITHUB_TOKEN` was used instead). **Recommendation: revoke that token**, since it has been exposed in conversation.
- **Managed Pricing plans** (Free/Starter $19/Pro $39) must be created in the Partner Dashboard by a human; the app reads them via `activeSubscriptions` and needs no Billing-API code (per spec).

## How to run and test

```bash
# 0. Node 22 (.nvmrc); npm install already done in this workspace.

# 1. Postgres for integration tests (sandbox resets wipe it — see PROGRESS.md):
sudo apt-get update -qq && sudo apt-get install -y -qq postgresql
sudo service postgresql start
sudo -u postgres psql -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='openhands') THEN CREATE ROLE openhands SUPERUSER LOGIN PASSWORD 'openhands'; END IF; END \$\$;"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='shelfcheck_test'" | grep -q 1 || sudo -u postgres createdb -O openhands shelfcheck_test

# 2. Environment (env.server reads process.env; export these):
export DATABASE_URL="postgresql://openhands:openhands@127.0.0.1:5432/shelfcheck_test?connection_limit=5"
export TEST_DATABASE_URL="$DATABASE_URL"
export ENCRYPTION_KEY="v1:$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
export SIGNING_KEY="v1:$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"

# 3. Schema + full gate (i18n check, typecheck, lint, fixtures, unit, integration, secrets):
npx prisma migrate deploy
npm run verify            # currently: 57 unit + 28 integration green, exit 0

# 4. Individual suites:
npm test                   # unit only
npm run test:integration   # real Postgres
npm run fixtures:generate  # regenerates seed-catalog + 50k-variant JSONL fixtures

# 5. Dev server (needs real Shopify credentials in .env — see HUMAN_STEPS.md):
npm run dev                # shopify app dev; embedded app requires a Partner app + dev store
```

Known caveat: `npm run test:e2e` is wired in package.json but has no config/specs yet (see Half-done), and `npm run dev` needs SHOPIFY_API_KEY/SECRET from a Partner app, which this environment does not have.
