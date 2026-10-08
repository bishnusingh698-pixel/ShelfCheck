# ShelfCheck — Build Progress

Status: **Phases 0-6 + encrypting session storage complete; next commit closes the session-storage/API-pin packet. Phase 3 remainder (webhook intake/uninstall/redact/subscription routes), then Phases 7-13.**

## Resume protocol
1. Read `PROGRESS.md` (this file), then `DECISIONS.md` (titles), then the current phase in `docs/SPEC.md`.
2. Start Postgres (see "Environment gotchas"), export env vars (see "Verify command"), run `npm run verify`.
3. Continue from the first unfinished work packet.

## Environment gotchas (read first)
- The sandbox resets between sessions: PostgreSQL 17 must be reinstalled/restarted, and the role/db recreated, before integration tests run:
  ```
  sudo apt-get update -qq && sudo apt-get install -y -qq postgresql
  sudo service postgresql start
  sudo -u postgres psql -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='openhands') THEN CREATE ROLE openhands SUPERUSER LOGIN PASSWORD 'openhands'; END IF; END \$\$;"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='shelfcheck_test'" | grep -q 1 || sudo -u postgres createdb -O openhands shelfcheck_test
  npx prisma migrate deploy   # with DATABASE_URL exported
  ```
- `env.server.ts` reads `process.env` only (no dotenv import); export keys in the shell or they come out empty. A stale `ENCRYPTION_KEY` exported in the shell silently overrides `.env` — `unset ENCRYPTION_KEY SIGNING_KEY` if tests report key-material errors.
- Keys must decode to >= 32 bytes: generate with `node -e 'console.log("v1:"+require("crypto").randomBytes(32).toString("base64"))'` (see D-28).

## Done
### Phase 0 (commit 47c9b1b)
- Platform facts researched and recorded in `docs/api-notes.md`. Admin API version pinned: **2026-07**.
- Template of record: `Shopify/shopify-app-template-react-router` (React Router 7.18.x, Prisma 6.19).

### Phases 1-2 (commit 705267f)
- Scaffold: package.json (scripts wired to template), server/index.ts + server/worker.ts (Express + RR7 handler + SIGTERM), .gitignore, .env.example, .nvmrc (22), prisma schema (11 models).
- Migration `20261007082509_init` applied; **up → down → up verified** (2 bugs found in down.sql and fixed).
- Partial unique indexes verified live: Scan one-active-per-shop, Job dedupe-pending, Issue open-status.
- Core lib: env, db (cold-start retry), logger, crypto (AES-256-GCM + key versioning), timing-safe (HMAC), rate-limit (ON CONFLICT fixed window), advisory-lock (transaction-scoped bigint key), admin-graphql (THROTTLED backoff), admin-urls, shop-context.
- Jobs: queue (FOR UPDATE SKIP LOCKED, dedupe, backoff, reclaim), handlers (zod), tick (idempotent), scheduler (shop-TZ period starts), watchdog.
- Billing: plans.ts, gating.ts (pure; limits match spec).
- Detectors (pure): gs1 (mod-10), barcode-hints, row-rules, registry, health-score, normalize, fingerprint.
- CSV escape (RFC 4180 + formula injection). i18n skeleton: config, resolve-locale, i18n.server (ICU plural subset), format.ts, locales/en.json.

### Phases 3-6 (commit cfe4162)
- Scan engine: bulk-query, bulk-operation, jsonl-schema, jsonl-stream (bounded memory), orchestrator, reconcile; issues lifecycle (snooze/ignore/intentional + regrowth); duplicates SQL detectors.
- i18n engine wired (self-contained ICU renderer, D-23); en (218 keys) + generated en-XA.
- Integration suite: scan engine, queue/tick/cold-start, seeded-catalog exact counts, 50k-variant memory (RSS 267 MB < 300 MB budget).

### Session storage + API-version pin (uncommitted → next commit)
- `app/lib/session-storage.server.ts`: encrypting SessionStorage adapter (D-26), 8/8 integration tests.
- `app/shopify.server.ts`: pinned to `ADMIN_API_VERSION` ("2026-07" = ApiVersion.July26, D-27); removed plaintext PrismaSessionStorage.
- Dev `.env` keys regenerated (31-byte → 32-byte material, D-28).
- `npm run verify` full gate green (see below).

## Webhook layer + admin executor (this commit)
- Webhook layer complete: `app/webhooks/` (intake, processors, uninstall, redact), routes `webhooks.app.uninstalled.tsx`, `webhooks.app.scopes_update.tsx`, `webhooks.app-subscriptions.update.tsx`, `webhooks.compliance.tsx`, `webhooks.bulk-operations.finish.tsx`; all HMAC-verified via `authenticate.webhook`, intake→webhook_events→`webhook_process` job, compliance payloads scrubbed to `{shop_domain}`.
- `app/billing/subscription.server.ts` (Managed Pricing read path, 5-min plan cache), `app/lib/shop-info.server.ts` (isolated `shop` query), `app/lib/shop-bootstrap.server.ts` (afterAuth hook: upsert shop, sync tz/currency/handle, trigger install scan once).
- `app/jobs/executor.server.ts` (`makeJobExecutor`, `adminContextExecutor`, `adminContextExecutorFromUnauthenticated`, `MissingSessionError`), `app/jobs/handler-map.server.ts` (zod-validated handler map + `productionDrainHandler`), `app/routes/jobs.tick.tsx` (cron entry: timing-safe secret, rate-limited, bounded drain).
- **Integration tests: `tests/integration/webhooks.test.ts` (17 tests)** — HMAC-signed Requests against the real route actions (401 on tamper, dedupe on webhookId, PII scrubbing, unknown-topic ack, idempotent replay), uninstall semantics (sessions deleted synchronously, pending jobs + telegram tokens cleared, catalog kept), scopes_update (scopes stored, auto-tag disabled when write_products dropped), all three compliance topics end-to-end, subscription plan mapping + cache behavior, processor registry.
- **Bugs found and fixed by those tests:** (1) D-29 — `authenticate.webhook` delivers topics in the library's storage form (`APP_SCOPES_UPDATE`); processors are now dual-registered under both forms or EVERY production webhook would have been acknowledged unprocessed. (2) D-30 — `shop/redact` cascade-deletes its own webhook event and job rows mid-run; `completeJob`/`failJob`/event bookkeeping now tolerate Prisma P2025 at exactly those update sites.
- `tests/helpers/shopify-test-env.ts` — first-import env bootstrap (SHOPIFY_APP_URL/API_KEY/API_SECRET/SCOPES) because `app/shopify.server.ts` evaluates `shopifyApp()` at import time and throws on an empty appUrl.
- `npm run verify` full gate green: 57 unit + 45 integration (was 28), i18n 0 errors/10 warnings, typecheck+lint clean, RSS 261 MB (< 300 MB), secrets:check clean (107 files).

## Next
1. Phase 7: product-sync, inventory-sync, autotag loop-protection tests (acceptance 2/3/6/7/9) — registers `products/create|update|delete`, `inventory_levels/update` processors (Phase 7 per spec).
2. Phases 8-9 (UI routes/components + UI harness), 10-11 (Resend digest, Telegram), 12 (10 locales + listings), 13 (hardening, live-acceptance script).

## Verify command
```
export DATABASE_URL="postgresql://openhands:openhands@127.0.0.1:5432/shelfcheck_test?connection_limit=5"
export TEST_DATABASE_URL="$DATABASE_URL"
export ENCRYPTION_KEY="v1:$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
export SIGNING_KEY="v1:$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
npm run verify   # i18n:pseudo, i18n:check, typecheck, lint, fixtures:generate, unit (57), integration (45), secrets:check
```
Last full run: **exit 0** — i18n 0 errors/10 warnings (missing locale files only), typecheck+lint clean, 57 unit + 45 integration passed (webhooks 17, queue 13, session-storage 8, scan-engine, jsonl-memory), RSS 261 MB, secrets:check clean (107 files).

## Known issues / rate-limit incidents
- None. (Model-request budget: target <=30/min, batching tool calls.)
- Live checks (dev store, Neon, Resend, Telegram, cron) impossible without credentials — mapped to `HUMAN_STEPS.md`.
- i18n:check warnings are only the 10 not-yet-written locale files (de, fr, es, pt-BR, pt-PT, zh-CN, ja, it, nl, sv) — Phase 12.

