# ShelfCheck — agent memory

Read order for any session: `PROGRESS.md` → `DECISIONS.md` (titles) → current phase in `docs/SPEC.md` (spec is at `docs/SPEC.md`, NOT the repo root).

## Durable gotchas (each cost real debugging time — check here first)

1. **Never name a module `*.client.*` if server code imports it.** The React Router Vite plugin stubs such modules in the SSR bundle (`const X = void 0`), silently breaking server rendering. (D-35)
2. **Express 4 / path-to-regexp v0: the catch-all must be exactly `app.all("*")`.** `*any`, `/*splat`, `/{*splat}` compile to never-matching patterns → every React Router route 404s. (D-36)
3. **The custom Express server must serve `build/client` itself** (`express.static(...)` before the RR handler). Otherwise every `/assets/*` 404s and the app never hydrates — SSR-only Playwright tests still pass, so curl an asset from the SSR HTML to catch it. (D-37)
4. **`en-XA` (pseudo locale) is intentionally absent from `SUPPORTED_LOCALES`**; only the UI harness (`NODE_ENV=test` + `UI_HARNESS=1`) honors `?locale=en-XA` in `app/routes/app.tsx`. (D-38)
5. The sandbox resets between sessions: reinstall/start PostgreSQL, recreate `shelfcheck_test` DB, `npx prisma migrate deploy`, export env keys (`env.server.ts` reads `process.env` only; keys ≥ 32 bytes, `v1:`+base64). See PROGRESS.md "Environment gotchas".
6. Tests: `npm run verify` = i18n:pseudo → i18n:check → typecheck → lint → fixtures:generate → unit → integration → secrets:check. E2E runs separately as `npm run test:e2e` (Playwright boots the real built app through `tsx server/index.ts`). i18n:check's 10 "locale file missing" warnings are expected until Phase 12.
7. **`Response.text()` silently strips a leading UTF-8 BOM** (fetch spec UTF-8 decode), so a BOM export looks BOM-less through `res.text()`. Assert on raw bytes (`arrayBuffer()` → EF BB BF) or decode with `new TextDecoder("utf-8", { ignoreBOM: true })`. The CSV route DOES emit the BOM — the test reader was wrong, not the route. (Phase 9)
8. **Postgres text ops treat NULL as "unknown", not empty**: `NULL || x` yields NULL and aggregates skip NULL inputs. In merged-view SQL (variant index + issue-details fallback) COALESCE each ingredient separately — e.g. `COALESCE(v."skuRaw", i."details"->>'sku')` per column, never `COALESCE(v."skuRaw" || i."details"->>'sku', …)` — or rows with NULL columns silently drop out of filters/search. (Phase 9)

## Conventions
- Commit per work packet, phase-titled (`Phase 8: …`), with `npm run verify` green; otherwise prefix `wip:` and note it in PROGRESS.md.
- Zero hard-coded user-facing strings — everything through `t()`, keys namespaced (`app.documentTitle` style); after adding an en.json key, regenerate en-XA (`npm run i18n:pseudo`) — en-XA.json is gitignored.
- Health-score band words are title case per SPEC (<health_score>): "Needs attention", not "needs attention".
