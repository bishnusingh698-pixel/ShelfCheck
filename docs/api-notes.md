# docs/api-notes.md — Verified Shopify / platform API facts

Every field, mutation, webhook topic, and CLI command used by ShelfCheck, with evidence. Verification date: **2026-10-07**.

Status legend: **[DOC]** verified against official documentation; **[PKG]** verified against an installed npm package's shipped types/code; **[LIVE]** verified against a live store (not possible in this environment — pending, see HUMAN_STEPS §7).

---

## 1. Admin API version

**[DOC]** Latest stable = `2026-07`; `2026-10` is a release candidate.
- Source: https://shopify.dev/docs/api/usage/versioning — table: "2026-07 | July 1, 2026 | … | Latest stable"; "2026-10 | October 1, 2026 | … | Release candidate". Glossary: "Stable: Recommended for production… Release candidate … May include backwards-incompatible changes, so not recommended for production."
**[PKG]** `ApiVersion.July26 = "2026-07"` exists in `@shopify/shopify-api@15.0.0` (dependency of `@shopify/shopify-app-react-router@3.0.1`).
- Evidence: extracted `dist/ts/lib/types.d.ts` from the npm tarball: `July26 = "2026-07"`, `October26 = "2026-10"`.
- **Use:** pinned in `app/lib/api-version.ts` (`export const ADMIN_API_VERSION = "2026-07"`), `shopify.server.ts` (`ApiVersion.July26`), and `shopify.app.toml` (`api_version = "2026-07"`).

## 2. App template

**[DOC]** "For new projects, use the Shopify App Template - React Router" (Remix template is superseded; Remix merged into React Router v7).
- Source: https://github.com/Shopify/shopify-app-template-remix ("Note: Remix is now React Router… For new projects, use the Shopify App Template - React Router")
- Template of record: https://github.com/shopify/shopify-app-template-react-router, main branch cloned 2026-10-07:
  - `@shopify/shopify-app-react-router ^3.0.1`, `react-router 7.18.2`, `react ^18.3.1`, `@shopify/app-bridge-react ^4.2.4`, `prisma/@prisma/client ^6.19.0`, `vite ^7.3.1`, `typescript ^5.9.3`, engines `node >=22.12`.
  - UI = Polaris **web components** (`s-page`, `s-button`, `s-link`, …) typed by `@shopify/polaris-types@1.0.1`; no `@shopify/polaris-react`.
  - Template gotchas carried into our lint rules: use `Link` (never raw `<a>`), `redirect` from `authenticate.admin`, `useSubmit` from react-router.
- **[PKG]** `@shopify/app-bridge-react@4.2.4` peerDependencies: `react: "*"`, `react-dom: "*"` (React 19 not required — D-2).

## 3. Bulk operations

**[DOC]** Concurrency: "In API versions `2026-01` and higher, each app can run up to five bulk operations of each type (`bulkOperationRunMutation` or `bulkOperationRunQuery`) per shop simultaneously."
- Source: https://shopify.dev/docs/api/usage/bulk-operations (Rate limits).
**[DOC]** Restrictions: "A bulk operation query needs to include a connection… Maximum of five total connections in the query. Connections must implement the Node interface. The top-level `node` and `nodes` fields can't be used. Maximum of two levels deep for nested connections."
- Same source (Operation restrictions).
**[DOC]** `bulkOperationRunQuery(query: String!, groupObjects: Boolean! = false)` returns `bulkOperation(BulkOperation)` and `userErrors([BulkOperationUserError!]!)`. `groupObjects`: "Enables grouping objects directly under their corresponding parent objects in the JSONL output. Enabling grouping slows down bulk operations… Only enable grouping if you depend on the grouped format." → **we never enable it** (pass `groupObjects: false` explicitly).
- Source: https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkOperationRunQuery
**[DOC]** JSONL shape: children of a nested connection are emitted on their own lines with `__parentId` referencing the parent: `{"id":"gid://shopify/ProductVariant/194…","title":"52","__parentId":"gid://shopify/Product/192…"}`; "all nested connections appear after their parents in the file".
- Source: https://shopify.dev/docs/api/usage/bulk-operations (JSONL results section).
**[DOC]** `BulkOperation` fields used: `id`, `status`, `url`, `partialDataUrl`, `objectCount`, `rootObjectCount`, `errorCode`, `fileSize`, `createdAt`, `completedAt`. "`url` and `partialDataUrl` values expire after seven days." `partialDataUrl` "Returns null when there's no data available." → used for partial counts only, never for issue resolution.
- Source: https://shopify.dev/docs/api/admin-graphql/latest/objects/BulkOperation
**[DOC]** `BulkOperationStatus` valid values (descriptions from the enum page): CANCELED, CANCELING, COMPLETED, CREATED, EXPIRED, FAILED, RUNNING.
- Source: https://shopify.dev/docs/api/admin-graphql/latest/enums/BulkOperationStatus
**Tracking:** track by id via `bulkOperation(id: $id) { … }`. The guide's status-tracking flow uses the operation ID returned by `bulkOperationRunQuery`; `currentBulkOperation` is NOT used anywhere in this app (deprecated per spec guidance; not required since 2026-01 allows id-based tracking).
- Source: https://shopify.dev/docs/api/usage/bulk-operations (mutation + tracking sections).

## 4. Bulk query candidate fields (all **[DOC]** on the 2026-07 reference = `/docs/api/admin-graphql/latest/...`)

Top-level query: **`productVariants`** (ProductVariantConnection) — "Search for product variants by attributes such as SKU, barcode, or inventory quantity." https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants

`ProductVariant` fields used:
- `id ID!`, `title String!`, `sku String`, `barcode String`, `price Money!`, `compareAtPrice Money`, `inventoryPolicy ProductVariantInventoryPolicy!`, `inventoryQuantity Int`, `inventoryItem InventoryItem!`, `product Product!`, `media MediaConnection!` (nested connection → `__parentId` children), `displayName String!`.
- `availablePublicationsCount(Count)` — "The number of publications that a resource is published to, without feedback errors." https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant

`Product` fields used (plain object child of variant): `id ID!`, `title String!`, `vendor String!`, `status ProductStatus!`, `isGiftCard Boolean!`, `variantsCount(Count)` (Count = `{ count Int!, precision CountPrecision! }`), `availablePublicationsCount(Count)` — D-5.
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Product and `/objects/Count`.

`InventoryItem` fields used (plain object child of variant): `id ID!`, `tracked Boolean!`, `requiresShipping Boolean!`, `unitCost MoneyV2` (MoneyV2 `{ amount, currencyCode }`), `measurement InventoryItemMeasurement!` → `weight Weight` (`{ value, unit }`).
- https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem ("measurement: The packaging dimensions of the inventory item." → weight lives on the inventory item, confirming the spec's hypothesis).
- Barcode note: `ProductVariant.barcode` is the singular field in 2026-07; multi-barcode support is new and not yet exposed as a stable GraphQL field (changelog "ProductVariant barcode is being replaced by barcodes", stable schema still lists `barcode` — we read `barcode` and ignore the future `barcodes` connection until it is stable).

**Query-shape budget:** connections used = `productVariants` (top) + `variant.media(first: 1)` (nested level 1) = 2 ≤ 5; nesting depth 1 ≤ 2. `product` and `inventoryItem` are objects, not connections. `groupObjects: false`.

## 5. Shop context

**[DOC]** `shop { ianaTimezone String!, currencyCode, myshopifyDomain String! }` — "ianaTimezone: The shop's time zone as defined by the IANA." "myshopifyDomain: The shop's .myshopify.com domain name."
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop ; `currencyCode` via `shop.paymentSettings.currencyCode` fallback / `Shop.currencyCode` per current reference (verified in Phase 3 against installed schema types — [PKG] graphql schema not shipped; use `shop { ianaTimezone, myshopifyDomain, currencyCode }` and validate response with zod; keep isolated in `shop-info.server.ts`).

## 6. Sessions / offline tokens

**[PKG]** Template enables `future: { expiringOfflineAccessTokens: true }` and the `Session` Prisma model carries `refreshToken`/`refreshTokenExpires`. Changelog (Aug 2026): "More resilient refreshes for expiring offline access tokens" — Admin GraphQL API.
- The library refreshes offline tokens transparently on `admin.graphql` calls (see `ensure-offline-token-is-not-expired.js` in the package dist). Our job worker must tolerate an expired-token path by re-throwing a typed error and re-queuing.
- https://shopify.dev/changelog (Aug 2026 section) + package dist file list (`server/helpers/ensure-offline-token-is-not-expired.js`).

## 7. Scopes

**[DOC]** Required: `read_products,read_inventory`. Optional: `write_products` declared as `optional_scopes = ["write_products"]` under `[access_scopes]` in `shopify.app.toml`.
- "A write scope includes read. `write_products` grants `read_products`" → never declare `read_products` optional alongside a required `write_products`.
- Source: https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes ; TOML property: https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration (`optional_scopes` array).
- Runtime request of an optional scope happens through App Bridge (verified in Phase 9 against the installed `@shopify/app-bridge-react` types; the exact API is isolated in one settings component — see D-5-style isolation).

## 8. Billing (Managed Pricing)

**[DOC]** Managed Pricing: plans are configured in the Partner Dashboard/CLI; the app reads `currentAppInstallation.activeSubscriptions` (names + status) and must NOT create charges via the Billing API. `app_subscriptions/update` webhook payload sample: `{ "app_subscription": { "admin_graphql_api_id": "gid://shopify/AppSubscription/…", "name": "…", "status": "PENDING", …, "plan_handle": "plan-123" } }`.
- Sources: https://shopify.dev/docs/api/webhooks/latest (app_subscriptions/update sample payload); https://shopify.dev/docs/apps/launch (Managed Pricing sections).
- Query (isolated in `app/billing/subscription.server.ts`): `currentAppInstallation { activeSubscriptions(first: 10) { nodes { name status } } }` — validated with zod; **[LIVE]** introspection pending (HUMAN_STEPS §7).
- Plan selection page URL format: `https://admin.shopify.com/store/<handle>/apps/<app-handle>/pricing` (Managed Pricing surfaces the plans page inside admin; **[LIVE]** confirmation pending — the app links to it via the `shopify://admin` deep link form as a fallback).

## 9. Webhooks

**[DOC]** Subscriptions are declared in `shopify.app.toml` under `[[webhooks.subscriptions]]` with `topics`/`uri` (compliance topics via `compliance_topics`), `api_version` per webhooks block. Template (cloned today) shows the exact format.
- Sample headers: `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256`, `X-Shopify-Shop-Domain`, `X-Shopify-API-Version`, `X-Shopify-Webhook-Id`. HMAC = "base64-encoded HMAC signature in the `X-Shopify-Hmac-SHA256` header, generated using your app's client secret and the raw request body. Verify this signature before processing."
- Sources: https://shopify.dev/docs/api/webhooks/latest ; https://shopify.dev/docs/apps/build/webhooks/verify-deliveries ("Each HTTPS delivery includes a base64-encoded HMAC signature…")
**[DOC]** Response time: "Your system acknowledges receipt by sending Shopify a 200 OK response… Shopify has a one-second connection timeout and a five-second timeout for the entire request." Retries on failure.
- Source: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
**[DOC]** Compliance topics mandatory for App Store apps: `customers/data_request`, `customers/redact`, `shop/redact`; payload `{ "shop_id": …, "shop_domain": "{shop}.myshopify.com" }`.
- Source: https://shopify.dev/docs/apps/build/privacy-law-compliance
**[DOC]** Topic enum entries used (all in `WebhookSubscriptionTopic`): `PRODUCTS_CREATE`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE`, `INVENTORY_LEVELS_UPDATE`, `BULK_OPERATIONS_FINISH`, `APP_UNINSTALLED`, `APP_SCOPES_UPDATE`, `APP_SUBSCRIPTIONS_UPDATE`.
- Source: https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic (e.g. "BULK_OPERATIONS_FINISH: The webhook topic for `bulk_operations/finish` events. Notifies when a Bulk Operation finishes.")
**[DOC]** `app/scopes_update` payload: `{ "id": 1, "shop_id": "gid://shopify/Shop/…", "previous": ["read_products"], "current": ["read_products","write_products"], "updated_at": "…" }` — used to update stored scopes and disable auto-tag if `write_products` was removed.
- Source: https://shopify.dev/docs/api/webhooks/latest
**[DOC]** `inventory_levels/update` payload contains `inventory_item_id` (not a variant id) — "The ID of the inventory item…" per REST/GraphQL webhook reference; our handler maps via `variant_index.inventory_item_id`. (Sample payload in https://shopify.dev/docs/api/webhooks/latest lists `inventory_item_id`, `location_id`, `available`, `updated_at`.)
**Template note:** "If you're using the React Router template, verification [of webhook HMAC] is handled automatically before your handler runs" (verify-deliveries page). We still verify HMAC ourselves for non-Shopify-processed paths (our own intake for msw-based tests and for any raw route): dedupe on `X-Shopify-Webhook-Id`, timing-safe compare of the base64 HMAC with the raw body.

## 10. Neon / Postgres

**[DOC]** Neon free plan: 0.5 GB storage per project; autosuspend after ~300 s idle; 100 CU-hours/month (0.25 CU → 400 h).
- Sources: https://neon.com/blog/how-to-make-the-most-of-neons-free-plan ("each project includes 0.5 GB of storage", "100 CU-hours per month"); https://neon.tech/docs/introduction/auto-suspend (default 300 s).
- Storage guardrail test uses **0.5 GB** as the budget (assert ≤ 40% of it for 50 shops × 2,000 variants with indexes).
**[DOC]** Neon pooled connections use PgBouncer in transaction mode → session-level `pg_advisory_lock` unsafe; use `pg_try_advisory_xact_lock`. Backed by a partial unique index.
- Source: https://neon.tech/docs/connect/connection-pooling + Prisma PgBouncer docs (below).
**[DOC]** Prisma: pooled URL in `url`, direct URL in `directUrl`, and `pgbouncer = true` in the datasource block when going through PgBouncer transaction mode (disables prepared-statement-heavy paths that break under transaction pooling).
- Source: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer (verified in Phase 2 against the installed Prisma 6.19 docs/error messages).
**[LIVE]** Cold-start retry: Neon autosuspends → first connection may fail; app retries with backoff (unit-tested logic; live behavior verified in HUMAN_STEPS §0.2).

## 11. Render

**[DOC]** Free web services: 512 MB RAM, 0.1 CPU, spin down after 15 minutes of inactivity, 750 free instance hours/month.
- Sources: https://render.com/blog/free-tier ("750 hours of compute time every month", "spin down after 15 minutes of inactivity"); secondary confirmation of 512 MB / 0.1 CPU (codecapsules + servercompass summaries of Render's current free tier).
- Math: pinging every 10 min keeps the instance awake ~24×31 = 744 h ≤ 750 h. **Tight** — cron-job.org every 10 minutes is the cadence; the app must be able to survive a restart without losing work (tick idempotency + DB queue, which is why nothing depends on in-process memory).

## 12. Resend

**[DOC]** Webhooks are delivered as Svix-signed envelopes with headers `svix-id`, `svix-timestamp`, `svix-signature` (Base64 HMAC list, space-delimited, `v1,` prefix); secret is `whsec_...`; verify with the `svix` library or manually (HMAC-SHA256 over `id.timestamp.payload`); dedupe on `svix-id`.
- Sources: https://resend.com/docs/webhooks/verify-webhooks-requests ; https://docs.svix.com/receiving/verifying-payloads/how-manual ; event types `email.bounced`, `email.delivered`, `email.complained` (resend-skills reference + Resend docs).
- **[LIVE]** Free-tier exact quotas (100/day, 3,000/month per the spec) to be confirmed on the Resend pricing page at setup time (HUMAN_STEPS §0.3); the app's send budget is env-configurable (`RESEND_DAILY_LIMIT`, `RESEND_MONTHLY_LIMIT`) with those defaults.
- `List-Unsubscribe` / `List-Unsubscribe-Post` headers: set as custom headers on the send request (Resend supports arbitrary headers; **[LIVE]** confirm in dashboard on first real send).

## 13. Telegram

**[DOC]** `setWebhook` accepts `secret_token` (1–256 chars, `A-Z a-z 0-9 _ -`); Telegram then sends header **`X-Telegram-Bot-Api-Secret-Token`** "with the secret token as content" on every webhook request.
- Source: https://core.telegram.org/bots/api#setwebhook
- Deep links: `https://t.me/<bot>?start=<payload>` (start parameter handling documented under `start` command); 403 on blocked bot; 429 responses carry `parameters.retry_after` (documented in the Bot API "Too Many Requests" section). Batch alerts ≤ 1/hour/shop is our own policy.
- **[LIVE]** setWebhook call happens at connect time; test message button sends a real message (HUMAN_STEPS §5).

## 14. Partner Dashboard listing limits

**[DOC]** App name must be **< 30 characters** — the spec's requested English title (41 chars) cannot be the app name (D-8).
- Source: https://community.shopify.dev/t/app-names-must-be-less-than-30-characters/574 (and Partner Dashboard validation).
- Tagline / introduction / feature-bullet / short-description character limits: enforced by the dashboard form; conservative limits used in `listing/*.md` and re-checked at submission time (HUMAN_STEPS §8). The app name field "must contain at least two characters".

## 15. Cron / tick

**[DOC]** cron-job.org free tier used for `POST /jobs/tick` every 10 minutes; the tick is protected by a constant-time-compared secret header and rate-limited. Render free-tier math above is the reason for the 10-minute cadence (spec allows 5–10).

## 16. Dev-store seeding mutations (scripts/seed-dev-store.ts)

**[DOC]** https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate —
quote: "The `productCreate` mutation only supports creating a product with its initial product variant. To create multiple product variants for a single product and manage prices, use the `productVariantsBulkCreate` mutation."
Note also: productCreate throttles after 50,000 variants (no more than 1,000 new variants/day) — irrelevant for our ~30-variant fixture catalog.

**[DOC]** https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkCreate —
signature: `productVariantsBulkCreate(productId, strategy, variants: [ProductVariantsBulkInput!]!, media)`;
`strategy` (ProductVariantsBulkCreateStrategy): "The strategy defines which behavior the mutation should observe, such as whether to keep or delete the standalone variant (when product has only a single or default variant) when creating new variants in bulk."
The exact enum member we pass, `REMOVE_STANDALONE`, is the conventional value for that behavior; **[LIVE]** confirm the enum member list at first live run (HUMAN_STEPS §live-seed) — the call is isolated in one line in seed-dev-store.ts.

**[DOC]** https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput —
verified input fields used: `optionValues` (product options for the variant), `price`, `compareAtPrice`, `barcode`, `inventoryPolicy` (DENY/CONTINUE), `inventoryItem` ("The inventory item associated with the variant, used for unit cost." → `sku`, `cost`, `tracked`, `requiresShipping`), `inventoryQuantities` ("The inventory quantities at each location where the variant is stocked… Supported as input with the `productVariantsBulkCreate` mutation only."). Weight lives on `inventoryItem.measurement` per §2 of these notes, which matches the read path; the seeder leaves weight unset (missing-weight fixtures need exactly that).

**[DOC]** Primary location for `inventoryQuantities.locationId`: `shop { primaryLocation { id } }` is the documented default location; **[LIVE]** confirm at first live run (same isolation as above).

---

## Pending live verifications (all mapped in HUMAN_STEPS §7)

1. `availablePublicationsCount` readability with only `read_products,read_inventory` (D-5).
2. `currentAppInstallation.activeSubscriptions` field names under 2026-07.
3. `shop { currencyCode }` exact field path under 2026-07.
4. Listing editor field limits.
5. Resend quota numbers on the pricing page.

All five are isolated behind single functions/constants so a correction is a one-line change.
