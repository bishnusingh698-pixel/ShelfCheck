# docs/plan.md — ShelfCheck architecture, data model, risks, work packets

Refines `<architecture>`, `<file_manifest>`, and `<data_model>` in docs/SPEC.md with verified facts (see docs/api-notes.md).

## 1. System architecture (verified refinements)

One Node process (Render free web service, 512 MB RAM):

```
server/index.ts (Express)
  ├── security headers: CSP frame-ancestors 'self' https://<shop>.myshopify.com
  │   (via template's addDocumentResponseHeaders for HTML + our own for non-doc routes)
  ├── raw-body capture BEFORE JSON parsing (webhooks: Shopify HMAC + Resend Svix + Telegram secret)
  ├── @react-router/express createRequestHandler → app/routes/* (build/server/index.js)
  ├── /healthz, /jobs/tick, /unsubscribe, /webhooks/*, /telegram/webhook (React Router routes, same handler)
  ├── worker loop started in-process (claims jobs while awake; correctness independent of it)
  └── SIGTERM → stop claiming, drain current job (≤30 s), prisma.$dispose(), exit
```

React Router v7 (framework mode) renders the UI; the Express entry exists because the same process must serve webhooks with raw bodies, run the worker, and handle SIGTERM — which `react-router-serve` cannot.

**Request flow (embedded admin):** browser → Shopify admin iframe → session token → `authenticate.admin` → `shopify.session.sessionStorage.loadSession` → `shop-context.server.ts` resolves the `shops` row (the only source of `shop_id`) → service layer.

**Scan flow (state machine in `orchestrator.server.ts`):**
```
trigger → advisory xact lock + partial-unique-guarded INSERT (status=queued)
       → job `scan.start` → bulkOperationRunQuery(groupObjects:false) → status=running
       → bulk_operations/finish webhook OR `scan.poll` job (backoff 5s→60s; whichever first wins; loser no-ops)
       → status=parsing → stream JSONL → batched upserts into variant_index (seen_scan_id)
       → stop at plan cap; record over_cap_count
       → detectors (SQL duplicate groups + in-code row rules) → issues lifecycle (preserve snoozed/ignored/intentional)
       → resolve issues not seen in this scan → reconcile (delete unseen rows) only on success
       → status=completed (counts, health score) → enqueue notifications
failure → retry ≤3 with backoff → status=failed (+watchdog fail for >60 min stuck)
```

**Tick (`POST /jobs/tick`, secret + rate-limited, idempotent):** start due scheduled scans → send due digests → reopen expired snoozes → watchdog → drain jobs ≤20 s (bounded to stay inside cron HTTP timeouts); the in-process worker drains the rest while awake.

**Storage of secrets:** offline tokens only inside the encrypted Prisma session store (AES-256-GCM wrapper around `@shopify/shopify-app-session-storage-prisma`); Telegram chat ids AES-256-GCM encrypted in `shops.settings`; signed tokens (unsubscribe, telegram-link, tick) use a dedicated HMAC key with key-versioned prefix `v1:`.

## 2. Data model (final)

Prisma models (PostgreSQL 15+; Neon): `Session` (template shape + our encryption), `Shop`, `Scan`, `VariantIndex`, `Issue`, `IgnoreRule`, `WebhookEvent`, `Job`, `NotificationLog`, `TelegramLinkToken`, `RateLimitBucket`.

Key indexes (raw SQL in migrations):
- `scans`: partial unique `(shop_id) WHERE status IN ('queued','running','parsing')`
- `variant_index`: PK `(shop_id, variant_gid)`; btree `(shop_id, sku_norm)`, `(shop_id, barcode)`, `(shop_id, inventory_item_id)`, `(shop_id, product_gid)`
- `issues`: unique `(shop_id, type, variant_gid, group_key)`; `(shop_id, status, severity)`; `(shop_id, group_key)`
- `jobs`: partial unique `(dedupe_key) WHERE status='pending'`; `(status, run_at)`
- `webhook_events`: unique `(webhook_id)`
- `notification_log`: unique `(shop_id, channel, kind, period_key)`
- `rate_limit_buckets`: PK `(key, window_start)`

`shops.settings` (jsonb) shape (zod-validated in code): enabled issue types, include_draft, include_archived, accept_non_gtin_barcodes, digest{enabled,email,day,hour,skip_when_empty}, telegram{chat_id_enc,enabled,disabled_reason}, auto_tag.

Migrations are forward-only in Prisma; every `migration.sql` ships a hand-written `down.sql`, and CI runs up→down→up.

## 3. Top 10 risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | `availablePublicationsCount` unreadable with approved scopes (D-5) | Isolated in `bulk-query.ts` + `scripts/verify-api.ts`; documented fallback (`publishedAt` → Online Store only) behind the same constant; detector only reads the stored `published_any_channel` column. |
| 2 | JSONL stream blows the 512 MB Render limit on 50k-variant stores | Line-by-line streaming via fetch ReadableStream + readline transform; batches of 500 upserted per transaction; integration test measures peak RSS < 300 MB. |
| 3 | Instance sleeps between webhook and job execution | All work is persisted (`webhook_events` → `jobs`); tick is idempotent and drains; nothing lives only in memory. Acceptance 9 proves it. |
| 4 | Session advisory locks break under Neon PgBouncer | Only `pg_try_advisory_xact_lock` inside short transactions; the partial unique index is the real guard. |
| 5 | Duplicate-processing of webhooks/retries creating duplicate issues | Dedupe on `X-Shopify-Webhook-Id` (unique index) + idempotent handlers (issue upsert keyed by `(shop_id,type,variant_gid,group_key)`); acceptance 6 test. |
| 6 | Auto-tag → products/update → auto-tag loop | Fingerprint compare before any write; test counts handler invocations and Shopify writes (acceptance 7). |
| 7 | Deleting variant rows after a failed/over-cap scan (data loss) | Reconcile only when `status=completed` AND `over_cap_count = 0` for the affected rows; tested explicitly. |
| 8 | Plan gating bypassed by client claims | Plan is read server-side only (5-min cache) from `currentAppInstallation.activeSubscriptions`; every gate checked in loaders/actions. |
| 9 | i18n string drift between locales | `scripts/i18n-check.ts` fails the build on missing/extra/empty keys, placeholder mismatch, missing plural categories, untranslated strings (allowlist for brand terms). |
| 10 | Render 750 h/month exceeded | cron every 10 min ⇒ ~744 h max; tick work is bounded and DB-backed; if the budget is hit, the service merely sleeps until month end (documented). |

## 4. Verification plan (npm run verify)

`verify` = `i18n:check` → `typecheck` → `lint` → `test` (unit) → `test:integration` → `test:e2e` (Playwright + axe, all locales) → `secrets:check`. Integration tests need a local Postgres (`TEST_DATABASE_URL`, default `postgres://openhands:openhands@127.0.0.1:5432/shelfcheck_test`).

## 5. Work packets (per phase)

- **P0:** SPEC.md, PROGRESS/DECISIONS/HUMAN_STEPS, api-notes, plan, i18n choice. (done)
- **P1:** wp1 template copy + deps install; wp2 strict TS + ESLint (no-any, no raw JSX text, no physical CSS props); wp3 Vitest (unit+integration projects) + test helpers; wp4 scripts (i18n-check, pseudo-locale, secrets-check, seed-catalog, gen-fixtures, seed-dev-store) + `verify`; wp5 Express entry + worker skeleton + render.yaml + shopify.app.toml (scopes/webhooks).
- **P2:** wp1 prisma schema + migrations (+down.sql, up-down-up test); wp2 env/db/logger/crypto/timing-safe; wp3 rate-limit + advisory-lock + storage-estimate test.
- **P3:** wp1 shopify.server + session storage encryption + shop-context; wp2 admin-graphql client + shop-info; wp3 billing (plans/gating/subscription + webhook); wp4 webhook intake + uninstall + redact + compliance; wp5 i18n skeleton + locales/en.json + en-XA generation.
- **P4:** wp1 queue + handlers; wp2 tick + scheduler + watchdog; wp3 worker + SIGTERM + healthz + jobs.tick route.
- **P5:** wp1 bulk-query + fixture test; wp2 bulk-operation + poll job + finish webhook; wp3 jsonl schema/stream + normalize + fingerprint; wp4 fixtures generation.
- **P6:** wp1 detectors (gs1, barcode-hints, row-rules, registry, types); wp2 duplicates SQL; wp3 issues lifecycle + snooze + ignore-rules + queries + health-score; wp4 orchestrator + reconcile.
- **P7:** wp1 product-sync + products webhooks; wp2 inventory-sync + webhook; wp3 autotag + loop-protection tests.
- **P8:** wp1 app shell + root + i18n provider; wp2 dashboard + onboarding + scan status; wp3 plan usage/banner/locked + skeletons/empty/error; wp4 ui-harness + Playwright en/en-XA + axe.
- **P9:** wp1 issues list + detail + bulk actions + undo; wp2 rules + settings; wp3 plans + csv escape/export; wp4 e2e for all screens.
- **P10:** wp1 digest selection + idempotency; wp2 email render + resend client; wp3 send-budget + unsubscribe (token + route) + resend webhook.
- **P11:** wp1 telegram-link + webhook; wp2 telegram send/batch + 403/429; wp3 settings UI connect + test button.
- **P12:** wp0 GLOSSARY; wp1–wp10 one locale each (de, fr, es, pt-BR, pt-PT, zh-CN, ja, it, nl, sv); wp11 TRANSLATION_REVIEW + listings; wp12 i18n:check green + plural tests + per-locale e2e.
- **P13:** wp1 perf + a11y pass; wp2 security review; wp3 docs (README/SUBMISSION_CHECKLIST/PRIVACY_POLICY/.env.example); wp4 verify-api + live-acceptance scripts + final HUMAN_STEPS; wp5 acceptance-report.

## 6. i18n library

**i18next + i18next-icu + react-i18next** (D-6). Server instance configured per-request with the resolved locale; client instance hydrated with the same namespace bundle; ICU plurals/select throughout; `Intl.*` for formatting with the shop's currency and IANA time zone.
