# docs/phase-reports/phase-0.md

## What was built (Phase 0 — plan and verify, no app code)

- `docs/SPEC.md` — the entire build prompt, verbatim.
- `PROGRESS.md`, `DECISIONS.md` (12 entries), `HUMAN_STEPS.md` (9 top-level steps).
- `docs/api-notes.md` — verified platform facts with evidence URLs and package introspection.
- `docs/plan.md` — refined architecture, data model, top-10 risks, work-packet plan, i18n choice.

## Pre-mortem (how Phase 0 could fail) — written before doing the work

1. **Stale API version** — pinning the wrong version poisons the whole build (schema drift, invalid fields). Mitigated by reading the shopify.dev versioning table directly and cross-checking the enum in the exact npm package version the template uses.
2. **Inventing a field** (e.g. a "published to any channel" field that requires a hidden scope) — mitigated by isolating D-5 behind one constant with a documented fallback.
3. **Wrong template generation** (using the deprecated Remix template or an old branch) — mitigated by cloning the official template repo today and recording its package.json contents.
4. **Unverifiable live facts silently treated as verified** — mitigated by the [DOC]/[PKG]/[LIVE] status tags in api-notes and HUMAN_STEPS §7.
5. **Infrastructure assumption errors (Neon/Render limits)** — mitigated by citing current official sources (0.5 GB Neon storage, Render 512 MB / 750 h) and encoding them into tests.

## Commands run and results

- `git clone --depth 1 https://github.com/Shopify/shopify-app-template-react-router.git` → succeeded; template files inspected (package.json, shopify.app.toml, prisma/schema.prisma, app/routes/*).
- `npm view @shopify/shopify-app-react-router version` → 3.0.1; `@shopify/shopify-api@15.0.0` tarball extracted; `ApiVersion.July26 = "2026-07"` confirmed in `dist/ts/lib/types.d.ts`.
- `npm view @shopify/app-bridge-react@4.2.4 peerDependencies` → `react: "*"`, `react-dom: "*"` (React 18 pinned by template — D-2).
- `npm view i18next / i18next-icu / react-i18next / intl-messageformat` → 26.4.2 / 2.5.0 / 17.0.16 / 12.1.3 (D-6).
- `npm view @react-router/express versions` → 7.18.x line exists (Express adapter available for RR v7).
- Official docs fetched for: versioning, bulk operations (+mutations/enums), ProductVariant/Product/InventoryItem/Count/Shop objects, webhooks (+verify-deliveries, compliance, topic enum), optional scopes, Telegram Bot API setWebhook, Resend/Svix webhook verification, Neon free plan, Render free tier.
- PostgreSQL 17.11 installed locally; `shelfcheck_test` DB created and connectivity confirmed with `psql` (`select 'ok'` returned ok).

## Decisions made (IDs)

D-1 (scaffold from template repo), D-2 (React 18), D-3 (missing template files), D-4 (2026-07 pin), D-5 (availablePublicationsCount, unverified-live isolated), D-6 (i18next), D-7 (local Postgres for tests), D-8 (app name < 30 chars), D-9 (PgBouncer strategy), D-10 (uninstall retention), D-11 (schedule defaults), D-12 (live checks → HUMAN_STEPS).

## Gate check

All required Phase 0 files exist; every `<platform_facts_to_verify>` item has a status: verified ([DOC]/[PKG]) or "unverified live, isolated in <file>" (availablePublicationsCount → `app/scan/bulk-query.ts`; activeSubscriptions/currency field paths → `app/billing/subscription.server.ts` / `app/lib/shop-info.server.ts`; listing limits → Phase 12). Gate passed.

## Open risks carried forward

1. `availablePublicationsCount` scope readability (D-5) — verify-api script + documented fallback.
2. Playwright + Polaris web components may not load from Shopify CDN in the test environment — deviation path already specified in `<testing>`; will confirm in Phase 8.
3. Partner Dashboard listing field limits only partially verified — resolve in Phase 12 with the live dashboard.
