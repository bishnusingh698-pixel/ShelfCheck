# v2 → v3 upgrade: removal checklist

Inventory from the case-insensitive search over the repo (excluding `node_modules`, `.git`, `DECISIONS.md`, `docs/phase-reports/`) for: `resend`, `svix`, `telegram`, `digest`, `unsubscribe`, `List-Unsubscribe`, `notify_locale`, `notifyLocale`, `notification_log`, `notificationLog`, `notified_email`, `notified_telegram`, `telegram_link`, `send-budget`, `sendBudget`, `email`.

Unrelated `email`/`digest` matches (kept, they are not notification code): `Session.email` (library PrismaSessionStorage schema for the Shopify session table — template-mandated), `crypto.server.ts`/`timing-safe.server.ts` "digest" (Node crypto hash API names), `logger.server.ts` redaction list entry for the Telegram webhook header (removed with the feature), `svix` in `resend.webhook.tsx` only (deleted), HUMAN_STEPS.md mentions (rewritten in step h).

## a) Files to delete
- `app/notifications/digest.server.ts`
- `app/notifications/email-render.server.ts`
- `app/notifications/resend.server.ts`
- `app/notifications/send-budget.server.ts`
- `app/notifications/unsubscribe.server.ts`
- `app/routes/unsubscribe.tsx`
- `app/routes/resend.webhook.tsx`
- `tests/integration/notifications.test.ts` (tests only the removed feature, step g)

## b) Files to edit (code)
- `app/jobs/handler-map.server.ts` — remove `digest_send` handler + import of `runDigestSend`
- `app/jobs/handlers.server.ts` — remove `DIGEST_SEND_SCHEMA`, `TELEGRAM_ALERT_SCHEMA`, kinds `digest_send`, `notify_new_issues`, `telegram_alert`
- `app/jobs/tick.server.ts` — remove `sendDueDigests` step + `digestsSent` from TickResult
- `app/jobs/scheduler.server.ts` — digest comment
- `app/scan/orchestrator.server.ts` — remove `notify_new_issues` enqueue block (this also fixes a latent runtime bug: that kind had no registered handler, so every scan with opened issues produced a failing job that retried to cap)
- `app/webhooks/uninstall.server.ts` — remove `telegramLinkToken.deleteMany`, digest comments
- `app/webhooks/redact.server.ts` — notification/telegram comment
- `app/billing/plans.ts` — remove `emailDigest`/`telegram`, add v3 fields (priceUsd, weeklySummary, activityHistoryDays), prices Starter $4.99 / Pro $9.99
- `app/billing/gating.ts` — remove `digest`/`telegram` feature flags, add `weeklySummary`/`activityHistoryDays`
- `app/lib/shop-context.server.ts` — remove `digest`/`telegram` settings schema, `notifyLocale`, `lastDigestAt`
- `app/routes/app.settings.tsx` — remove digest + telegram sections, `notifyLocale`, delivery-problems query
- `app/routes/app._index.tsx` — nothing notification-specific (verify)
- `app/components/OnboardingChecklist.tsx` — remove "Set up the weekly digest" step
- `app/env.server.ts` — remove RESEND_*, TELEGRAM_* vars
- `app/lib/logger.server.ts` — remove telegram-header redaction path
- `app/lib/admin-urls.ts` — check email/telegram link helpers
- `app/i18n/config.ts` + `app/i18n/i18n.server.ts` — notifyLocale references
- `scripts/secrets-check.ts` — remove resend/telegram token patterns
- `prisma/schema.prisma` — remove NotificationLog, TelegramLinkToken models, Shop.notifyLocale/lastDigestAt, Issue.notifiedEmailAt/notifiedTelegramAt

## c) Database objects (one new migration with hand-written down.sql — never edit an applied migration)
- Drop tables: `NotificationLog` (`notification_log`), `TelegramLinkToken` (`telegram_link_tokens`)
- Drop columns: `shops.notify_locale`, `shops.last_digest_at`, `issues.notified_email_at`, `issues.notified_telegram_at`
- Strip `digest` and `telegram` keys from `shops.settings` jsonb (UPDATE ... settings - 'digest' - 'telegram')
- Delete pending jobs of removed kinds: `jobs.kind in ('digest_send','notify_new_issues','telegram_alert')`
- down.sql recreates everything dropped

## d) Env vars
- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM`, `RESEND_DAILY_LIMIT`, `RESEND_MONTHLY_LIMIT`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`

## e) Dependencies
- No npm packages were Resend/Telegram-specific (transport was `fetch`); `package.json` unchanged for these features.

## f) Locale keys (en.json; en-XA regenerated)
- `email.*` (subject/greeting/newIssues/stillOpen/unsubscribeHelp/...)
- `telegramMessage.*`
- `unsubscribe.*`
- `settings.digest.*`, `settings.telegram.*`
- `settings.language.notifications`
- `onboarding.setUpDigest`
- `plans.locked.digest`, `plans.locked.telegram`
- `plans.differences.digest`, `plans.differences.telegram`

## g) Tests
- Delete `tests/integration/notifications.test.ts` (22 tests, all about removed features)
- `tests/unit/pure-logic.test.ts` — remove digest/telegram featureEnabled assertions; add weeklySummary/activityHistoryDays/price assertions
- `tests/unit/security-and-i18n.test.ts` — remove email.digest sentence-plural test, telegram URL test; adjust admin-urls test
- `tests/helpers/db.ts` — remove `notifyLocale` from factory
- `tests/e2e/dashboard.spec.ts` — remove digest onboarding step assertion
- `tests/integration/webhooks.test.ts` — uninstall test cleanup lists (telegram tokens); adjust
- `tests/integration/issues-routes.test.ts` — check notified_* references

## h) Docs
- `.env.example` — remove Resend/Telegram sections
- `PROGRESS.md` — rewrite to v3 phase state
- `HUMAN_STEPS.md` — remove Resend/Telegram setup steps (rewritten at Phase 12)
- `README.md` — remove digest mentions (Phase 12 rewrite adds Capacity section)
- `docs/api-notes.md` — mark digest/Resend/Telegram sections superseded (append, do not rewrite history)
- `STATUS_REPORT.md` — historical document; annotated only

## Order of execution (each step ends with `npm run verify` green + a commit)
1. (a) routes/UI + (f) locale keys + settings/billing edits touching them
2. (b) job kinds, tick, scheduler, orchestrator, webhooks
3. (c) delete `app/notifications/` folder
4. (d) one new migration with down.sql
5. (e) env vars
6. (g) tests
7. (h) docs
