# Amendment 001 — Removal checklist and report

Amendment: `docs/spec-amendments/001-remove-email-telegram.md` (remove email digest + Telegram alerts).
Build state at start: **Phase 10 (email digest) complete; Phase 11 (Telegram) not started.** Section 2 of the amendment applies.

## 0. Inventory (search from §2.1)

One case-insensitive search over the repo (excluding `node_modules`, build output, `.git`, `DECISIONS.md`, `docs/phase-reports/`, `docs/spec-amendments/`) for `resend`, `svix`, `telegram`, `digest`, `unsubscribe`, `List-Unsubscribe`, `notify_locale`, `notifyLocale`, `notification_log`, `notificationLog`, `notified_email`, `notified_telegram`, `telegram_link`, `send-budget`, `sendBudget`, `email`.

### Files to delete
| File | Why |
|---|---|
| `app/notifications/` (whole folder) | `digest.server.ts`, `email-render.server.ts`, `resend.server.ts`, `send-budget.server.ts`, `unsubscribe.server.ts` — email digest only |
| `app/routes/unsubscribe.tsx` | One-click unsubscribe landing page (email-only) |
| `app/routes/resend.webhook.tsx` | Svix-signed Resend bounce webhook (email-only) |
| `tests/integration/notifications.test.ts` | 22 tests covering only removed code |

### Files to edit (source)
| File | Change |
|---|---|
| `app/routes/app.settings.tsx` | Remove digest section, Telegram connect section, delivery-problems (bounce) display, `notifyLocale` field+intent; keep interface-language field |
| `app/routes/app.plans.tsx` | Remove `emailDigest` and `telegram` plan-table rows |
| `app/routes/app._index.tsx` | Onboarding checklist: remove `setUpDigest` step |
| `app/components/OnboardingChecklist.tsx` | Remove `setUpDigest` label |
| `app/billing/plans.ts` | Remove `emailDigest` + `telegram` from `PlanLimits`/PLANS |
| `app/billing/gating.ts` | Remove `digest`/`telegram` from `featureEnabled` |
| `app/jobs/tick.server.ts` | Remove `sendDueDigests` call + `digestsSent` result field |
| `app/jobs/scheduler.server.ts` | Digest-comment mentions only (scheduled scans stay) |
| `app/jobs/handlers.server.ts` | Remove `DIGEST_SEND_SCHEMA`, `TELEGRAM_ALERT_SCHEMA`, `digest_send`/`notify_new_issues`/`telegram_alert` kinds |
| `app/jobs/handler-map.server.ts` | Remove `digest_send` handler + import of `runDigestSend` |
| `app/scan/orchestrator.server.ts` | Remove "enqueue notifications for newly opened issues" (`notify_new_issues` job); `first_seen_at` is set in `lifecycle.server.ts` and stays |
| `app/webhooks/uninstall.server.ts` | Remove telegram-link-token clearing + "stop notifications" comment |
| `app/webhooks/redact.server.ts` | Update comment (cascade list loses notifications/telegram tokens) |
| `app/lib/shop-context.server.ts` | Remove `digest` + `telegram` from `SHOP_SETTINGS_SCHEMA`; remove `notifyLocale`, `lastDigestAt` from `ShopContext`; make zod strip unknown keys (old rows parse safely) |
| `app/lib/shop-bootstrap.server.ts` | Stop writing `notifyLocale` |
| `app/lib/admin-urls.ts` | Remove `appPath` (only emails/Telegram used it — CSV uses `adminHttpsUrl`) |
| `app/lib/timing-safe.server.ts` | `signToken`/`verifyToken`/`hashForStorage` were for unsubscribe/telegram-link tokens only — remove; keep `timingSafeStringEqual` (tick secret), `timingSafeSecretEqual` (tick), `hmacHex`, `shopifyHmacBase64`, `verifyShopifyHmac` (Shopify webhooks) |
| `app/lib/logger.server.ts` | Remove `x-telegram-bot-api-secret-token` + `svix-signature` redaction paths; `email`/`*.email` redaction stays (sessions hold merchant emails) |
| `app/i18n/config.ts` | Remove `Telegram` from BRAND_TERMS |
| `app/env.server.ts` | Remove RESEND_* + TELEGRAM_* vars; keep SIGNING_KEY (tick secret) |
| `app/i18n/i18n.server.ts`, `app/i18n/translate.ts` | Comment mentions of "emails, Telegram" |
| `eslint.config.js` | Remove `Telegram` from brand-word set |
| `scripts/secrets-check.ts` | Remove `resend key` + `telegram bot token` patterns |
| `.env.example` | Remove RESEND_* + TELEGRAM_* blocks |

### Database objects (one new migration + hand-written down.sql)
- Delete pending `jobs` rows with `kind` IN (`digest_send`, `notify_new_issues`, `telegram_alert`).
- Drop tables `notification_log`, `telegram_link_tokens`.
- Drop columns `shops.notify_locale`, `shops.last_digest_at`, `issues.notified_email_at`, `issues.notified_telegram_at`.
- Strip `settings.digest` + `settings.telegram` keys from existing `shops.settings` rows.
- `schema.prisma`: drop `NotificationLog` + `TelegramLinkToken` models, the four columns, and their relations on `Shop`/`Issue`.
- Never edit applied migrations `20261007082509_init` / `20261010063255_add_notification_provider_id`.

### Env vars
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM`, `RESEND_DAILY_LIMIT`, `RESEND_MONTHLY_LIMIT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`.

### Dependencies
None. No email/Telegram SDK was ever installed: `resend.webhook.tsx` verified Svix signatures by hand (D-39), and no package.json entry for `resend`, `svix`, or any Telegram client exists. Lockfile needs no change (verified with grep over package.json).

### Locale keys (`locales/en.json`, regenerate en-XA via `npm run i18n:pseudo`)
- `dashboard.onboarding.setUpDigest`
- `settings.digest.*` (title, enabled, email, day, hour, skipWhenEmpty, test, bounces, none)
- `settings.telegram.*` (title, connect, connectHelp, connected, sendTest, disabled.blocked, disabled.other)
- `settings.language.notifications`
- `plans.locked.digest`, `plans.locked.telegram`, `plans.feature.digest`, `plans.feature.telegram`
- `email.*` (whole section), `telegramMessage.*` (whole section), `unsubscribe.*` (whole section)

### Shared modules — parts that REMAIN (edited, not deleted)
- `timing-safe.server.ts`: `timingSafeStringEqual` (tick secret compare), `timingSafeSecretEqual` (tick route), `hmacHex` (used by verifyToken — re-check; kept only if still referenced), `shopifyHmacBase64` + `verifyShopifyHmac` (all Shopify webhooks + watchers tests).
- `rate-limit.server.ts`: used by tick route, scan route, settings action — untouched.
- `admin-urls.ts`: `adminHttpsUrl` (plans pricing page, issue/CSV deep links), `appBridgeUrl`, `productAdminPath`, `variantInventoryAdminPath` remain.
- `scheduler.server.ts`: scheduled scans only (`runDueScheduledScans`, period starts) remain.
- `tick.server.ts`: scheduled scans, snooze reopening, watchdog, reclaim, drain, rate-limit pruning remain.
- `format.ts`, `translate.ts`, `i18n.server.ts`: remain (in-app i18n).
- `logger.server.ts`: redaction list keeps `email`/`*.email` (Shopify sessions store merchant email).
- `crypto.server.ts`: `sha256Hex`, `constantTimeEqual` keep other users (session storage, tests); `seal`/`tryOpen` unaffected.

### Tests
- Delete: `tests/integration/notifications.test.ts` (whole file — digest/Resend/Svix/unsubscribe only).
- Update: `tests/integration/issues-routes.test.ts` (settings action: drop digest + notifyLocale cases; loader featureEnabled shape), `tests/integration/webhooks.test.ts` (uninstall: drop digest_send job + telegramLinkToken rows), `tests/unit/pure-logic.test.ts` (plan gating: drop telegram/digest), `tests/unit/security-and-i18n.test.ts` (drop signToken/verifyToken + email.digest plural cases; keep sha256Hex, constantTimeEqual, HMAC, admin-URL cases), `tests/e2e/dashboard.spec.ts` (onboarding: drop "Set up the weekly digest"; KEY_MARKER namespace list drops `email`), `tests/helpers/db.ts` (TABLES list, createShop notifyLocale), `tests/integration/ui-routes.test.ts` (layout locale + settings loader references, if any).
- Do not weaken: uninstall/redact/queue/tick tests keep proving cancellation, cascade, drain behavior.

### Docs
- `README.md`: no Resend/Telegram/BotFather sections exist (README is still the template readme); confirm zero notification content.
- `HUMAN_STEPS.md`: remove §0.3 (Resend), §0.4 (Telegram), §5 (Acceptance 11 live delivery), renumber remaining steps, update the count line.
- `STATUS_REPORT.md`: remove notification mentions from status bullets (report-only file).
- `AGENTS.md`: update gotcha 9 (env caching — the RESEND example goes; the ESM-hoisting lesson stays with a neutral example), drop Phase 10 references in gotcha 7/9 context.
- `docs/plan.md`: remove notification items (architecture lines, models list, P10/P11 work packets).
- `docs/api-notes.md`: remove §12 (Resend), §13 (Telegram), and their [LIVE] checklist items.
- `docs/SPEC.md`: keep verbatim (it is the spec of record; the amendment header line at the top carries the override). **Exception:** none required by the amendment.
- `PRIVACY_POLICY.md`, `SUBMISSION_CHECKLIST.md`, `i18n/GLOSSARY.md`, `TRANSLATION_REVIEW.md`, `listing/<locale>.md`: **do not exist in this repo** (Phase 12/13 artifacts not yet created) — nothing to edit; when Phase 12 creates them they must follow the amended spec (no email/Telegram copy).
- `PROGRESS.md`: mark Phases 10 and 11 `Removed by amendment 001`; do not renumber.

### Unrelated `email` matches (kept, with reason)
- `prisma/schema.prisma` `Session.email/emailVerified` — Shopify session shape from the template; merchant identity, not outbound mail.
- `app/lib/logger.server.ts` redaction paths `email`, `*.email` — prevent logging session PII; still needed.
- `tests/integration/webhooks.test.ts` customer email in compliance payload — proves PII scrubbing; still needed.
- `locales/en.json` `settings.catalog.*`… no email keys outside the removed sections; `plans.locked.watchers` etc. stay.
- `scripts/secrets-check.ts` `SKIP_LINE_PATTERNS` `example[-_.@]` — generic, stays.
- Template README / SPEC verbatim body — SPEC stays verbatim per amendment rules.

## 1. Removal log (done in §2.2 order, one commit per step)

Baseline before removal: `npm run verify` = 121/123 integration tests green; the 2 failures are both in `tests/integration/notifications.test.ts` (Resend webhook route — env-caching artifact of the test env bootstrap, AGENTS.md gotcha 9) and that entire file is deleted by this amendment, so the removal starts from an otherwise-green gate.

Steps executed (prior session, committed):
1. Entry points/UI: deleted `app/routes/unsubscribe.tsx`, `app/routes/resend.webhook.tsx`, `app/notifications/` (5 files), `tests/integration/notifications.test.ts`; edited `app.settings.tsx`, `app.plans.tsx`, `app._index.tsx`, `OnboardingChecklist.tsx`.
2. Background work: `tick.server.ts` (digest send + result field), `handler-map.server.ts` + `handlers.server.ts` (3 job kinds), `orchestrator.server.ts` (notify_new_issues enqueue; `first_seen_at` retained in `lifecycle.server.ts`), `uninstall.server.ts` (token clearing), `redact.server.ts` (comment).
3. Modules: `timing-safe.server.ts` (token helpers), `shop-context.server.ts` (settings schema strips unknown keys), `admin-urls.ts` (`appPath`), `logger.server.ts`, `gating.ts`/`plans.ts`, `i18n/config.ts`, `env.server.ts`, `eslint.config.js`, `scripts/secrets-check.ts`.
4. Database: migration `20261011_remove_email_telegram_notifications` (+ hand-written `down.sql`); up → down → up verified. `schema.prisma` matches.
5. Configuration: 8 env vars removed from `app/env.server.ts` + `.env.example`. No packages to remove (§3).
6. Localization: 42 stale keys purged from `locales/en-XA.json` via regeneration (`npm run i18n:pseudo`); `i18n:check` = 0 errors.
7. Tests: notifications suite (22) deleted; `pure-logic`, `security-and-i18n`, `webhooks`, `issues-routes`, `ui-routes`, `db.ts` helper updated. No remaining-feature test weakened — all re-run green.
8. Docs: `HUMAN_STEPS.md` (prereqs + acceptance sections renumbered), `docs/plan.md`, `docs/api-notes.md`, `PROGRESS.md`, `STATUS_REPORT.md`, `AGENTS.md`; SPEC.md body kept as spec of record with the amendment pointer at line 1.

Post-removal fixes found by the proof runs:
- `app/lib/ui-harness.server.ts`: e2e exposed a pre-existing seeding race — concurrent SSR loaders both ran `findUnique`→`create` and the loser hit the shop-id unique constraint (PrismaClientKnownRequestError on the first dashboard request of a fresh DB). Fixed by coalescing concurrent `seedUiHarnessFixture` calls behind one in-flight promise (cleared on settle so per-test DB truncation still re-seeds). Fresh-DB and re-seeded e2e runs both green afterward.
- `docs/plan.md` core-loop line still said "→ enqueue notifications" — removed.
- `PROGRESS.md` webhooks summary still said "telegram tokens cleared"; verify figures were pre-amendment — both corrected.

## 2. Migration

`prisma/migrations/20261011_remove_email_telegram_notifications/` (up: deletes pending digest/telegram job rows, drops `notification_log` + `telegram_link_tokens`, drops `shops.notify_locale`/`shops.last_digest_at`/`issues.notified_email_at`/`issues.notified_telegram_at`, strips `settings.digest`+`settings.telegram` from existing rows; hand-written `down.sql` restores all of it). Applied-migration history `20261007082509_init` and `20261010063255_add_notification_provider_id` left untouched. Up → down → up verified; final state deployed: 3 migrations, no pending.

## 3. Packages removed

None — no email/Telegram package was ever a dependency (verified: `grep -E 'resend|svix|telegram' package.json` → no matches; D-39 chose the manual Svix HMAC verify). An all-dependencies reference sweep found every remaining package imported somewhere.

## 4. Final search output

Re-ran the §2.1 search after removal. Matches outside the excluded dirs, grouped:

- **Historical migrations (must not be edited):** `20261007082509_init/migration.sql` (13), `20261007082509_init/down.sql` (5), `20261010063255_add_notification_provider_id/migration.sql` (2) — they created what `20261011_remove…` drops; editing an applied migration is forbidden by the amendment.
- **The removal migration itself:** `20261011_remove_email_telegram_notifications/migration.sql` (12) + `down.sql` (16) — these lines are the removal working as intended.
- **Amendment documentation:** `docs/SPEC.md` (4: the `<notifications>` XML tags + the two "Removed by amendment 001" phase lines), `docs/plan.md` (2: P10/P11 removal notes), `PROGRESS.md` (2: status line + Phase 11 note).
- **Unrelated `email` matches (kept, explained):**
  - `app/lib/logger.server.ts` (3) — redaction paths `email`/`*.email`; Shopify sessions store the merchant's email, still must never be logged.
  - `tests/integration/webhooks.test.ts` (2) — customer email inside compliance payloads; proves PII scrubbing (acceptance 8).
  - `prisma/schema.prisma` (2) — `Session.email`/`Session.emailVerified`, the template's Shopify session shape; identity data, not outbound mail.
- **Zero matches** for `resend`, `svix`, `telegram`, `digest`, `unsubscribe`, `notify_locale`, `notification_log`, `notified_email`, `notified_telegram`, `telegram_link`, `send-budget` in any live source, test, config, locale, or doc outside the categories above. `locales/en-XA.json` regenerated from the cleaned `en.json` (0 stale keys; key parity 189/189).

## 5. Test results

`npm run verify` (exit 0): i18n:pseudo + i18n:check (189 strings, 0 errors, 10 warnings — all "locale file missing" for the Phase-12 locales, expected per AGENTS.md), typecheck clean, lint clean, fixtures generated, **unit 55/55**, **integration 101/101**, secrets:check clean (159 files).

`npm run test:e2e` (Playwright, real build via `tsx server/index.ts`, en + en-XA projects): **13 passed, 3 skipped** (the 3 are English-string assertions skipped by design in the en-XA project). Run twice — once against a fresh (truncated) database, once with the fixture already seeded — both green; the first run is what caught the seeding race.

Unused-exports/unused-dependencies check (acceptance 13 discipline, run for §4.2): a full symbol-reference sweep found **no dependency unused** and **no export orphaned by this removal**. 26 exported symbols are unreferenced but were already unreferenced at the pre-amendment baseline (verified per symbol against git history: definition-only references in both states) — e.g. `rateLimitPeek`, `variantInventoryAdminPath`, `formatCurrency`, `FakeClock`. They predate amendment 001, belong to remaining features or scaffolding, and are Phase 13's dead-code audit to disposition; §2.3's "change nothing else" rule forbids touching them in this packet. The removal introduced zero new dead code.

Acceptance re-runs (§4.3): 4 (intentional groups) — `issues-routes.test.ts` green; 6 (webhook duplicates + HMAC) — `webhooks.test.ts` 17/17 green; 8 (uninstall + redact) — uninstall semantics (sessions deleted, pending jobs cleared, catalog kept) + shop/redact cascade green; 9 (cold start) — `ui-routes.test.ts` + fresh-DB e2e green; 10 (plan limits) — `pure-logic.test.ts` gating/limits green with the amended `featureEnabled("watchers"|"autoTag")` shape; 11 (new) — "New" badge renders from `first_seen_at` (retained in the scan lifecycle), covered by `dashboard.spec.ts` "every string is translated" (en-XA) + dashboard e2e green in both projects.
