# Phase 7 — Watchers and auto-tag

## What was built

- `app/webhooks/product-sync.server.ts` — one-product refresh: cursor-paged
  GraphQL read (mirrors the frozen bulk query, D-34), fingerprint comparison
  (loop guard), variant upserts, row-rule re-detection, targeted duplicate
  re-checks over old AND new values (all group members, D-32), value-scoped
  duplicate resolution, row-rule resolution for this product's variants
  (including vanished ones), and `removeProductVariants` for deletions.
- `app/webhooks/inventory-sync.server.ts` — maps `inventory_item_id` →
  variants via the index, updates `inventoryQty`, re-evaluates ONLY
  `PUBLISHED_ZERO_INVENTORY`, opens and resolves accordingly.
- `app/autotag/autotag.server.ts` — the app's only Shopify write:
  add/remove `shelfcheck-fix` via `productUpdate(tags)`, gated on
  `settings.autoTag` + Pro plan + `write_products` scope; reads tags first
  so an already-correct product never produces a write; remembers tagged
  products in settings to untag them when their issues clear (D-31).
- Routes `webhooks.products.tsx`, `webhooks.inventory-levels.update.tsx`
  (HMAC via `authenticate.webhook`, intake dedupe/persist/enqueue, 200 fast).
- Processors registered for `products/create|update|delete` and
  `inventory_levels/update` (both topic forms, D-29); debounced enqueue with
  sliding `run_at` (30 s products, 5 s inventory, D-33); the freshest
  inventory payload is written onto the pending job.
- Job kinds `product_sync`, `inventory_sync`, `autotag_run` wired into the
  production handler map; `autotag_run` is enqueued by the orchestrator
  after a completed scan only.
- `tests/integration/watchers.test.ts` — 20 tests covering acceptance
  2, 3, 6, 7 [AUTO] plus gating, coalescing, deletion, untracked /
  continue-selling exclusions, and Free-plan no-op.

## Pre-mortem (before building)

1. Topic arrives in storage form (`PRODUCTS_CREATE`) and the processor
   silently acks — prevented by dual registration + explicit tests.
2. REST webhook payloads carry numeric ids, not GIDs — `productGidFromPayload`
   accepts both `admin_graphql_api_id` and numeric `id`.
3. Auto-tag loop — scan-only trigger + fingerprint guard + tag read-before-
   write; the test counts actual Shopify writes (exactly 1).
4. Resolving only the webhook's product leaves the other duplicate member
   open forever — resolution is scoped by group value shop-wide (D-32).
5. Debounce window losing the last edit — pending job payload/`run_at`
   updated in place; last value wins.

## Commands run and results

- `npx vitest run --project integration tests/integration/watchers.test.ts`
  → 20/20 passed (after fixing topic storage-form lookups and the
  duplicate-member resolution scope).
- `npx vitest run --project integration` → 6 files, **65/65 passed**
  (was 45).
- `npx tsc --noEmit` → clean. `npx eslint .` → clean.
- Full `npm run verify` re-run at the end of the phase (see PROGRESS.md).

## Decisions made

D-31, D-32, D-33, D-34 (see DECISIONS.md).

## Acceptance coverage from this phase

- 2 [AUTO] — copied SKU → DUPLICATE_SKU through the debounced job path. ✅
- 3 [AUTO] — SKU fix resolves both members with no rescan. ✅
- 6 [AUTO] — replayed delivery → one event, one issue set; bad HMAC → 401. ✅
- 7 [AUTO] — auto-tag never loops: exactly one Shopify write counted. ✅
- 9 [AUTO] — cold start covered by the queue tests (webhook persisted, job
  drained later); watcher jobs flow through the same queue.

## Open risks

- `PRODUCT_SYNC_QUERY` field set is doc-verified but not live-verified
  (D-34, HUMAN_STEPS §7).
- Inventory per-shop throttle constant exists
  (`INVENTORY_SYNC_PER_SHOP_PER_HOUR`) but enforcement is currently only the
  per-item coalescing; a sustained storm could still run one sync per item
  per 5 s. Human-paced admin edits make this unreachable in practice;
  revisit if webhook volume ever becomes machine-generated.
