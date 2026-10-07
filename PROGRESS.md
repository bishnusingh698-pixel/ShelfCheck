# ShelfCheck — Build Progress

Status: **Phase 2 core modules complete — committing; scan engine next**

## Resume protocol
1. Read `PROGRESS.md` (this file), then `DECISIONS.md` (titles), then the current phase in `docs/SPEC.md`.
2. Run `git log --oneline -20` and `npm run verify`.
3. Continue from the first unfinished work packet.

## Done
### Phase 0 (commit 47c9b1b)
- Platform facts researched and recorded in `docs/api-notes.md`. Admin API version pinned: **2026-07**.
- Template of record: `Shopify/shopify-app-template-react-router` (React Router 7.18.x, Prisma 6.19).
- PostgreSQL 17.11 installed locally (role `openhands`, password `openhands`, db `shelfcheck_test`) for integration tests in place of Neon.

### Phases 1-2 (uncommitted work below will be committed next)
- Scaffold: package.json (scripts wired to template), server/index.ts + server/worker.ts (Express + RR7 handler + SIGTERM), .gitignore, .env/.env.example, .nvmrc (22), prisma schema (11 models).
- Migration `20261007082509_init` applied; **up → down → up verified** (2 bugs found in down.sql and fixed).
- Partial unique indexes verified live: Scan one-active-per-shop, Job dedupe-pending, Issue open-status.
- Core lib: env, db (cold-start retry), logger, crypto (AES-256-GCM + key versioning), timing-safe (HMAC), rate-limit (ON CONFLICT fixed window), advisory-lock (transaction-scoped bigint key), admin-graphql (THROTTLED backoff), admin-urls, shop-context.
- Jobs: queue (FOR UPDATE SKIP LOCKED, dedupe, backoff, reclaim), handlers (zod), tick (idempotent), scheduler (shop-TZ period starts), watchdog.
- Billing: plans.ts, gating.ts (pure; limits match spec).
- Detectors (pure): gs1 (mod-10), barcode-hints, row-rules, registry, health-score, normalize, fingerprint.
- CSV escape (RFC 4180 + formula injection). i18n skeleton: config, resolve-locale, i18n.server (ICU plural subset), format.ts, locales/en.json.
- Tests: **57 unit + 13 integration, all green** (`npx vitest run`). `npx tsc --noEmit` clean.

## Next
1. Commit Phases 1-2.
2. Scan engine: bulk-query.ts (verified against fixtures), bulk-operation.server, jsonl-schema, jsonl-stream (500-1000 batches), orchestrator, reconcile.
3. Webhook intake + product/inventory sync + uninstall/redact.
4. Issue lifecycle (upsert/snooze/ignore/intentional), duplicates SQL.
5. Routes/UI (Phases 8-9), notifications (10-11), localization (12), hardening (13).

## Verify command
```
npx tsc --noEmit && npx vitest run
```
(`npm run verify` gets its full wiring in Phase 13 once i18n-check/pseudo-locale/secrets-check scripts exist.)

## Known issues / rate-limit incidents
- None. (Model-request budget: target ≤30/min, batching tool calls.)
- Live checks (dev store, Neon, Resend, Telegram, cron) impossible without credentials — mapped to `HUMAN_STEPS.md`.
- `npm run verify` script not yet the full gate (per above).

