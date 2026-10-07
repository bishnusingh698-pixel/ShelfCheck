# HUMAN_STEPS.md — ShelfCheck

Steps that need a human or real credentials. Each has exact instructions and expected results. [LIVE] acceptance criteria map here. Report results back and they will be folded into `docs/acceptance-report.md`.

Legend: PD = Shopify Partner Dashboard, Env = `.env` in the project root.

---

## 0. Prerequisites (one-time)

1. **Create a Partner account + dev store** at https://partners.shopify.com . Create a development store with the Shopify CLI or PD ("Apps → App setup → Create app" is not needed if you use `shopify app config push`).
   - Expected: a `client_id` and `client_secret` for the app, and a `<store>.myshopify.com` dev store.
2. **Neon** — https://neon.tech free plan. Create a project; copy the **pooled** connection string (ends `-pooler.xxx.neon.tech`) and the **direct** string.
   - Expected: `DATABASE_URL` (pooled) and `DIRECT_URL` set in Env; `npm run verify` integration tests pass against Neon when `TEST_DATABASE_URL` is pointed at Neon pooled.
3. **Resend** — https://resend.com free tier. Add + verify a sending domain (DNS records). Create an API key; create a webhook endpoint pointing at `https://<app-url>/webhooks/resend` and copy the signing secret (`whsec_...`).
   - Expected: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM` (`ShelfCheck <digest@yourdomain.com>`) in Env.
4. **Telegram** — create a bot with @BotFather (`/newbot`). Copy the bot token and choose a bot username.
   - Expected: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` in Env. `setWebhook` is done by the app (`POST /telegram/setup` dev route or the settings page does it automatically on connect).
5. **cron-job.org** — free account; create a job hitting `POST https://<app-url>/jobs/tick` every 10 minutes with header `x-tick-secret: <TICK_SECRET value>`.
   - Expected: job listed, and `/healthz` shows the instance stays awake.
6. **Render** — https://render.com free web service from this repo (`render.yaml`). Set all Env vars. Attach the Neon URLs.
   - Expected: service deploys, `GET /healthz` returns 200 with `{"db":"ok"}`.
7. **Managed Pricing** — PD → App → "Pricing" (or CLI `shopify app config push` after editing `shopify.app.toml`). Create plans: Free / Starter $19 (7-day trial) / Pro $39 (7-day trial) with the feature gates used by the app. Plan names must match `app/billing/plans.ts` handles: `free`, `starter`, `pro`.
   - Expected: `currentAppInstallation.activeSubscriptions` returns the plan name when a test store subscribes.

---

## 1. [LIVE] Acceptance 1b — Fresh install auto-scans and shows exact counts

1. Seed the dev store: `npm run seed:dev-store` (uses `SHELLFCHECK_DEV_ADMIN_TOKEN`/dev-store env; see script header for exact env vars: `SEED_STORE_SHOP`, `SEED_ADMIN_API_TOKEN`).
   - Expected: script prints the seeded catalog and the expected issue counts (they equal `scripts/seed-catalog.ts` expectations).
2. Install the app on the dev store (`shopify app dev`, open the preview URL).
   - Expected: install scan starts automatically; dashboard shows **the same counts as `seed-catalog.ts`** for every issue type, health score matches the computed value, and the onboarding checklist progresses.

## 2. [LIVE] Acceptance 2b/3b — Duplicating a product in admin creates then resolves a duplicate

1. With the app installed (Starter or Pro plan), duplicate a product that has a SKU in Shopify admin (Products → Duplicate).
   - Expected: within 2 minutes a `DUPLICATE_SKU` issue appears in the app (webhook path, not a rescan), marked "New".
2. Change the duplicated variant's SKU to something unique in admin.
   - Expected: within 2 minutes the issue resolves (status `resolved`) without a rescan.

## 3. [LIVE] Acceptance 5 — Empty store and 10k+ variant store

1. Install on an empty dev store. - Expected: friendly empty state; scan completes with 0 variants.
2. Generate a large catalog on a dev store (or lower the plan cap and scan a 10k store). - Expected: scan completes; dashboard shows counts; over-cap banner appears if beyond cap.

## 4. [LIVE] Acceptance 8b — Real uninstall and reinstall

1. Uninstall the app from the dev store. - Expected: sessions/tokens deleted (verify via `/healthz` DB check or Neon console: `Session` rows for the shop gone), notifications stop, app reinstalls without error, data is restored only after a fresh scan.
2. Run `shop/redact` (PD "Erase store data" in the app's privacy settings, or Shopify's customer data request tool). - Expected: every row for the shop gone from all tables (verify with the SQL in `docs/api-notes.md` §redact-verify).

## 5. [LIVE] Acceptance 11 — Real Resend + Telegram delivery

1. Configure a digest (Settings → Digest, Monday 09:00) and connect Telegram (Settings → Telegram connect; click the deep link within 15 minutes).
   - Expected: digest email arrives with `List-Unsubscribe` headers (inspect source), one-click unsubscribe works, Telegram test message arrives; block the bot and see the channel disabled in Settings.

## 6. [LIVE] Acceptance 12 — Web vitals in the real admin

1. Open the app inside the Shopify admin; run Lighthouse (or Shopify's web vitals checker in PD "Built for Shopify" section).
   - Expected: LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms.

## 7. Live API verification (Phase 0 follow-up)

Run `npm run verify:api` with `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and a shop+token in Env (see `.env.example`).
   - Expected: every field listed in `docs/api-notes.md` prints `OK`; specifically `availablePublicationsCount` is readable with only `read_products,read_inventory` (decision D-5). If it is NOT readable, the app's documented fallback applies (see api-notes) and no code change is needed by you.

## 8. App Store listing limits

Open PD listing editor and paste the copy from `listing/en.md`.
   - Expected: every field fits. Current limits used (verify in the dashboard; recorded in api-notes when you confirm): name < 30 chars, tagline/introduction/feature bullets as enforced by the form.

## 9. Final submission (explicitly out of scope for the agent)

Per the spec, the agent never submits to the App Store. `SUBMISSION_CHECKLIST.md` maps every Built for Shopify requirement to evidence. A human performs: `shopify app deploy`, Managed Pricing setup, listing submission.

---

## Count: 9 top-level human steps (each with sub-steps).
