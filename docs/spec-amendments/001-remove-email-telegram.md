# Amendment 001 — Remove email digest and Telegram alerts

**This amendment overrides `docs/SPEC.md` wherever they conflict.** All other rules still apply, including `<rate_limit>` (max 40 requests per minute), `<operating_mode>` (no questions, log decisions), and `<verification_discipline>`.

## 0. First steps
1. Save this amendment verbatim to `docs/spec-amendments/001-remove-email-telegram.md`.
2. Add one line at the very top of `docs/SPEC.md`: `> Amended by docs/spec-amendments/001-remove-email-telegram.md. The amendment wins on any conflict.`
3. Add a `DECISIONS.md` entry (Type: deviation) recording that the user removed the email digest and Telegram alerts from v1, and that **plan prices stay unchanged**.
4. Read `PROGRESS.md` to see how far the build has gone. Then follow section 1 if the notification code has not been built yet, or section 2 if any of it exists. If you are unsure, run the inventory in 2.1; it tells you.


## 1. If email and Telegram have not been built yet
Do not build them. Skip Phase 10 and Phase 11 entirely. Apply the spec changes in section 3 to everything you build from now on. Then do the final checks in section 4 at the end of the current phase.


## 2. If any email or Telegram code already exists: remove it completely


### 2.1 Inventory before deleting anything
Run one case-insensitive search across the repository (excluding `node_modules`, build output, `.git`, `DECISIONS.md`, `docs/phase-reports/`, and `docs/spec-amendments/`) for:
`resend`, `svix`, `telegram`, `digest`, `unsubscribe`, `List-Unsubscribe`, `notify_locale`, `notifyLocale`, `notification_log`, `notificationLog`, `notified_email`, `notified_telegram`, `telegram_link`, `send-budget`, `sendBudget`, `email`.

Write the results as a removal checklist into `docs/phase-reports/amendment-001.md`, grouped by: files to delete, files to edit, database objects, env vars, dependencies, locale keys, tests, docs. For each **shared** module that appears (for example `timing-safe.server.ts`, `rate-limit.server.ts`, `admin-urls.ts`, `format.ts`, `scheduler.server.ts`, `tick.server.ts`), note which of its parts are still used by remaining features. Those modules are edited, not deleted.

Note: `email` will also match unrelated things (for example Shopify session fields or the shop's contact email). Only remove code that exists for sending notifications.


### 2.2 Remove, in this order (commit after each step, keep `npm run verify` green)


1. **Entry points and UI first**
   - Delete routes: `unsubscribe.tsx`, `telegram.webhook.tsx`, `resend.webhook.tsx`.
   - In `app.settings.tsx`: remove the digest section, the Telegram connect section, the test-message button, the bounce/failure display, and the notification-language field. Keep the interface-language field.
   - In the onboarding checklist: remove the "set up digest" step. The checklist becomes: scan running, review issues. Do not add a replacement step.
   - In `app.plans.tsx` and `billing/plans.ts`: remove the "Email digest" and "Telegram" rows. Use the plan table in section 3.
2. **Background work**
   - Remove digest and Telegram logic from `tick.server.ts`, `scheduler.server.ts`, and `handlers.server.ts` (job kinds and handlers). Keep scheduled scans, snooze reopening, the watchdog, and job draining exactly as they are.
   - In the scan orchestrator and webhook sync code, remove "enqueue notifications for newly opened issues". Newly opened issues must still get `first_seen_at` set so the in-app "New" badge keeps working.
   - In `uninstall.server.ts`: remove "stop notifications" logic.
3. **Modules**
   - Delete the whole `app/notifications/` folder.
   - Remove functions in shared modules that only notifications used. Keep anything still referenced (verify with a search before deleting each function).
   - Remove plan-gating flags for digest and Telegram from `gating.ts`.
4. **Database** (one new migration, with a hand-written `down.sql`)
   - Never edit a migration that has already been applied; create a new one.
   - Delete pending rows in `jobs` whose `kind` belongs to digest or Telegram, so the worker never meets an unknown job kind.
   - Drop tables `notification_log` and `telegram_link_tokens`.
   - Drop columns `shops.notify_locale`, `shops.last_digest_at`, `issues.notified_email_at`, `issues.notified_telegram_at`.
   - Remove the `digest` and `telegram` keys from `shops.settings` JSON for existing rows, and from the `zod` schema that validates settings. The settings schema must still parse old rows safely (strip unknown keys rather than failing).
   - Update `schema.prisma` to match. Run the up, down, up migration test.
   - Update `redact.server.ts` and its test so the table list matches the new schema (the test must still prove every remaining table is cleared).
5. **Configuration**
   - Remove env vars for Resend, sending address, unsubscribe signing, Telegram bot token, bot username, and Telegram webhook secret from `env.server.ts` and `.env.example`.
   - Uninstall packages used only for email or Telegram (for example the Resend SDK, Svix, email templating libraries). Confirm each one is unused before removing it. Update the lockfile.
6. **Localization**
   - Delete every locale key that belongs to email, Telegram, digest, unsubscribe, or notification-language settings, in **all** locale files including generated `en-XA`.
   - Remove those terms ("digest") from `i18n/GLOSSARY.md` and from `TRANSLATION_REVIEW.md`.
   - Update `listing/<locale>.md` in every locale so no listing copy promises email or Telegram alerts. Re-check the character limits.
7. **Tests**
   - Delete tests that only cover removed code. Update tests that mention it (plan gating, tick, uninstall, redact, settings UI, onboarding, Playwright fixtures in the UI harness).
   - Do not delete or weaken a test just because it fails. If a remaining feature's test fails, the removal broke something: find and fix the root cause.
8. **Docs**
   - `README.md`: remove the Resend, Telegram, and BotFather setup sections and the related env vars and dependencies.
   - `PRIVACY_POLICY.md`: remove anything about storing merchant email addresses or Telegram chat IDs.
   - `SUBMISSION_CHECKLIST.md`, `HUMAN_STEPS.md`, `docs/plan.md`, `docs/api-notes.md`: remove notification items.
   - `PROGRESS.md`: mark Phases 10 and 11 as `Removed by amendment 001`. Do **not** renumber the other phases.


### 2.3 Rules for a clean removal
- **Remove fully.** No feature flags, no stubs, no commented-out code, no "coming soon" UI, no unused exports left behind.
- **Change nothing else.** Do not refactor, rename, or "improve" unrelated code while doing this. Only touch lines that exist because of email or Telegram.
- **Shared code:** before deleting any function, type, constant, or locale key, search for every reference to it. Delete only if nothing remaining uses it.
- If removing something makes a remaining feature behave differently, stop, re-read the relevant spec section, and fix it so the remaining feature behaves exactly as specified.


## 3. Spec changes (apply to `<plans_and_limits>`, `<notifications>`, `<data_model>`, `<acceptance>`, `<phases>`)


**Plans (prices unchanged):**


| | Free | Starter $19/mo | Pro $39/mo |
|---|---|---|---|
| Trial | n/a | 7 days | 7 days |
| Scans | 1 per calendar month | Weekly scheduled + manual (max 3/day, 10-minute cooldown) | Daily scheduled + manual (max 10/day, 10-minute cooldown) |
| Issues shown | First 50 (totals shown in full) | Unlimited | Unlimited |
| Variant cap | 500 | 5,000 | 50,000 |
| Webhook watchers | No | Yes | Yes |
| CSV export | Yes (50 rows) | Yes | Yes |
| Auto-tag | No | No | Yes |


**Notifications:** in-app only. Issues opened by webhooks or scans appear in the app with a "New" badge. There are no outbound messages of any kind.


**Removed from scope:** email digest, Telegram alerts, unsubscribe, Resend, notification language, `notification_log`, `telegram_link_tokens`, Phases 10 and 11, the email/Telegram parts of acceptance criterion 11.


**Acceptance criterion 11 becomes:** [AUTO] The "New" badge appears on newly opened issues and its text renders correctly in every locale.


## 4. Proof of completion
1. Re-run the search from 2.1. Expected result: **zero matches** outside `DECISIONS.md`, `docs/phase-reports/`, and `docs/spec-amendments/`, except unrelated `email` matches you list and explain in the amendment report.
2. Run `npm run verify` (typecheck, lint, i18n check, unit, integration, e2e in every locale, secrets check) and an unused-exports/unused-dependencies check. All must pass.
3. Re-run these acceptance checks and record results: 4 (intentional groups), 6 (webhook duplicates and HMAC), 8 (uninstall and redact), 9 (cold start), 10 (plan limits), and the new 11.
4. Finish `docs/phase-reports/amendment-001.md` with: what was removed, the migration name, packages removed, the final search output summary, and the test results.
5. Commit, update `PROGRESS.md`, and continue the build from where it was. Do not message the user about this amendment; it appears in the final report like everything else.
