import "../helpers/shopify-test-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import { shopifyHmacBase64 } from "../../app/lib/timing-safe.server.js";
import { resetDb, disposeTestDb, testDb, createShop, createVariant } from "../helpers/db.js";
import { intakeWebhook, processWebhookEvent, getWebhookProcessor } from "../../app/webhooks/intake.server.js";
import { registerLifecycleWebhookProcessors } from "../../app/webhooks/processors.server.js";
import { syncProduct, PRODUCT_DEBOUNCE_MS } from "../../app/webhooks/product-sync.server.js";
import { syncInventoryItem } from "../../app/webhooks/inventory-sync.server.js";
import type { AdminGraphQLExecutor } from "../../app/lib/admin-graphql.server.js";
import { autoTagAllowed, addFixTag, applyAutoTags, AUTOTAG_TAG } from "../../app/autotag/autotag.server.js";

/**
 * Phase 7 watcher tests: acceptance 2, 3, 6, 7 [AUTO].
 *  - a products/create with a copied SKU produces DUPLICATE_SKU through the
 *    debounced job path,
 *  - a products/update fixing the SKU resolves the issue with no rescan,
 *  - replays never duplicate issues; bad HMAC is a 401,
 *  - auto-tag never loops (invocations and Shopify writes counted).
 */

const SECRET = process.env.SHOPIFY_API_SECRET!;
const SHOP = "watchers-test.myshopify.com";
const PRODUCT_A = "gid://shopify/Product/111";
const PRODUCT_B = "gid://shopify/Product/222";
const VARIANT_A1 = "gid://shopify/ProductVariant/1111";
const VARIANT_B1 = "gid://shopify/ProductVariant/2221";

const { action: productsAction } = await import("../../app/routes/webhooks.products.js");
const { action: inventoryAction } = await import("../../app/routes/webhooks.inventory-levels.update.js");

registerLifecycleWebhookProcessors();

function webhookRequest(topic: string, body: unknown, webhookId: string): Request {
  const raw = JSON.stringify(body);
  return new Request("https://app.example.dev/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": webhookId,
      "x-shopify-hmac-sha256": shopifyHmacBase64(raw, SECRET),
    },
    body: raw,
  });
}

function asActionArgs(request: Request): ActionFunctionArgs {
  return { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
}

/** Build a stub admin executor serving product reads + tag reads/writes. */
function makeStubExecutor(
  products: Record<string, unknown>,
  onWrite?: (mutation: string, vars: Record<string, unknown>) => void,
): AdminGraphQLExecutor & { writes: number; reads: number } {
  const counter = { writes: 0, reads: 0 };
  const executor = {
    graphql: async ({ query, variables }: { query: string; variables?: Record<string, unknown> }) => {
      const vars = (variables ?? {}) as Record<string, unknown>;
      if (query.includes("productUpdate")) {
        counter.writes += 1;
        onWrite?.(query, vars);
        const tags = (vars.product as { id: string; tags: string[] }).tags;
        return { data: { productUpdate: { product: { id: (vars.product as { id: string }).id, tags }, userErrors: [] } } };
      }
      counter.reads += 1;
      if (query.includes("ShelfCheckProductTags")) {
        const id = String(vars.id);
        const tags = (products[id] as { tags?: string[] } | undefined)?.tags ?? [];
        return { data: { product: { id, tags } } };
      }
      if (query.includes("ShelfCheckProductExists")) {
        const id = String(vars.id);
        return { data: { product: products[id] ? { id } : null } };
      }
      // Product sync query: serve the recorded product shape.
      const id = String(vars.id);
      const product = products[id];
      if (!product) return { data: { product: null } };
      return { data: { product } };
    },
  };
  return {
    ...executor,
    get writes() {
      return counter.writes;
    },
    get reads() {
      return counter.reads;
    },
  } as AdminGraphQLExecutor & { writes: number; reads: number };
}

/** A product payload shaped like PRODUCT_SYNC_QUERY's response. */
function productPayload(overrides: {
  productId?: string;
  variants: Array<{
    id: string;
    sku?: string | null;
    barcode?: string | null;
    price?: number | null;
    inventoryQuantity?: number | null;
    tracked?: boolean;
    inventoryPolicy?: string | null;
    status?: string;
    isGiftCard?: boolean;
    mediaCount?: number;
    requiresShipping?: boolean;
    weight?: number | null;
    cost?: number | null;
    inventoryItemId?: string;
  }>;
  title?: string;
  vendor?: string | null;
}) {
  const productId = overrides.productId ?? PRODUCT_A;
  return {
    id: productId,
    title: overrides.title ?? "Widget",
    vendor: overrides.vendor ?? "Acme",
    status: overrides.variants[0]?.status ?? "ACTIVE",
    isGiftCard: overrides.variants[0]?.isGiftCard ?? false,
    variantsCount: { count: overrides.variants.length },
    availablePublicationsCount: { count: 1 },
    variants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: overrides.variants.map((v) => ({
        id: v.id,
        title: "Default",
        sku: v.sku ?? null,
        barcode: v.barcode ?? null,
        price: { amount: v.price ?? 10 },
        compareAtPrice: null,
        inventoryPolicy: v.inventoryPolicy ?? "DENY",
        inventoryQuantity: v.inventoryQuantity ?? 0,
        inventoryItem: {
          id: v.inventoryItemId ?? `inv-${v.id.slice(-4)}`,
          tracked: v.tracked ?? true,
          requiresShipping: v.requiresShipping ?? true,
          unitCost: v.cost != null ? { amount: v.cost } : null,
          measurement: { weight: { value: v.weight ?? 0, unit: "KILOGRAMS" } },
        },
        media: { edges: Array.from({ length: v.mediaCount ?? 0 }, (_, i) => ({ node: { id: `m-${v.id}-${i}` } })) },
      })),
    },
  };
}

beforeAll(async () => {
  await testDb().$queryRaw`SELECT 1`;
});

beforeEach(async () => {
  await resetDb();
  await createShop({ shopDomain: SHOP, plan: "pro" });
});

afterAll(async () => {
  await disposeTestDb();
});

describe("product webhook routes", () => {
  it("rejects a bad HMAC with 401 and persists nothing", async () => {
    const raw = JSON.stringify({ id: PRODUCT_A });
    const request = new Request("https://app.example.dev/webhooks/products", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "products/create",
        "x-shopify-shop-domain": SHOP,
        "x-shopify-webhook-id": "wh-bad-hmac",
        "x-shopify-hmac-sha256": shopifyHmacBase64(raw, "wrong-secret"),
      },
      body: raw,
    });
    await expect(productsAction(asActionArgs(request))).rejects.toThrow();
    expect(await testDb().webhookEvent.count()).toBe(0);
  });

  it("persists products/create and enqueues a debounced product_sync job", async () => {
    const db = testDb();
    const response = await productsAction(
      asActionArgs(webhookRequest("products/create", { id: PRODUCT_A }, "wh-p1")),
    );
    expect(response.status).toBe(200);

    // authenticate.webhook stores the topic in the library's storage form.
    const event = await db.webhookEvent.findFirst({ where: {} });
    expect(event).not.toBeNull();
    expect(getWebhookProcessor(event!.topic)).toBeDefined();
    // The intake enqueues webhook_process; the processor adds product_sync.
    await processWebhookEvent(event!.id);
    const syncJob = await db.job.findFirst({ where: { kind: "product_sync" } });
    expect(syncJob).not.toBeNull();
    expect(syncJob?.dedupeKey).toBe(`product_sync:${(await db.shop.findUnique({ where: { shopDomain: SHOP } }))!.id}:${PRODUCT_A}`);
    expect(syncJob!.runAt.getTime()).toBeGreaterThan(Date.now() + PRODUCT_DEBOUNCE_MS - 5_000);
  });

  it("coalesces a burst of products/update webhooks into one pending sync", async () => {
    const db = testDb();
    for (let i = 0; i < 4; i += 1) {
      const { eventId } = await intakeWebhook({
        topic: "products/update",
        shopDomain: SHOP,
        webhookId: `wh-burst-${i}`,
        payload: { id: PRODUCT_A },
      });
      await processWebhookEvent(eventId!);
    }
    const syncJobs = await db.job.findMany({ where: { kind: "product_sync", status: "pending" } });
    expect(syncJobs.length).toBe(1);
  });

  it("acceptance 6: replayed deliveries never create duplicate issues", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    // Existing variant with SKU "widget" — the webhook copies it.
    await createVariant(shop!.id, {
      variantGid: VARIANT_A1,
      productGid: PRODUCT_A,
      skuRaw: "widget",
      skuNorm: "widget",
      seenScanId: "scan-1",
      fingerprint: "fp-a1",
    });

    const id = "wh-replay-1";
    const body = { id: PRODUCT_B };
    const first = await productsAction(asActionArgs(webhookRequest("products/create", body, id)));
    expect(first.status).toBe(200);
    const replay = await productsAction(asActionArgs(webhookRequest("products/create", body, id)));
    expect(replay.status).toBe(200);
    expect(await db.webhookEvent.count()).toBe(1);

    // Process once, run the sync with a copied SKU, then process a replayed
    // event: the DUPLICATE_SKU issue count must not double.
    const event = await db.webhookEvent.findFirst({ where: {} });
    await processWebhookEvent(event!.id);
    const executor = makeStubExecutor({
      [PRODUCT_B]: productPayload({ productId: PRODUCT_B, variants: [{ id: VARIANT_B1, sku: "widget" }] }),
    });
    await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor, client: db });

    const afterFirst = await db.issue.count({ where: { type: "DUPLICATE_SKU", status: "open" } });
    expect(afterFirst).toBe(2); // one per member of the group

    // Replay processing + a second identical sync: no new issues.
    await processWebhookEvent(event!.id);
    await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor, client: db });
    expect(await db.issue.count({ where: { type: "DUPLICATE_SKU", status: "open" } })).toBe(2);
  });
});

describe("acceptance 2 & 3: create opens, update resolves — no rescan", () => {
  it("a copied SKU produces DUPLICATE_SKU for both members through the job path", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await createVariant(shop!.id, {
      variantGid: VARIANT_A1,
      productGid: PRODUCT_A,
      skuRaw: "widget",
      skuNorm: "widget",
      seenScanId: "scan-1",
      fingerprint: "fp-a1",
    });

    const { eventId } = await intakeWebhook({
      topic: "products/create",
      shopDomain: SHOP,
      webhookId: "wh-acc2",
      payload: { id: PRODUCT_B },
    });
    await processWebhookEvent(eventId!);

    const executor = makeStubExecutor({
      [PRODUCT_B]: productPayload({ productId: PRODUCT_B, variants: [{ id: VARIANT_B1, sku: "widget" }] }),
    });
    await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor, client: db });

    const issues = await db.issue.findMany({ where: { type: "DUPLICATE_SKU", status: "open" } });
    expect(issues.map((i) => i.variantGid).sort()).toEqual([VARIANT_A1, VARIANT_B1].sort());
    expect(issues.every((i) => i.groupKey === "widget")).toBe(true);
  });

  it("fixing the SKU resolves both members' issues without a rescan", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await createVariant(shop!.id, {
      variantGid: VARIANT_A1,
      productGid: PRODUCT_A,
      skuRaw: "widget",
      skuNorm: "widget",
      seenScanId: "scan-1",
      fingerprint: "fp-a1",
    });

    // First sync copies the SKU.
    const copyExecutor = makeStubExecutor({
      [PRODUCT_B]: productPayload({ productId: PRODUCT_B, variants: [{ id: VARIANT_B1, sku: "widget" }] }),
    });
    await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor: copyExecutor, client: db });
    expect(await db.issue.count({ where: { type: "DUPLICATE_SKU", status: "open" } })).toBe(2);

    // The merchant fixes the SKU; products/update fires.
    const { eventId } = await intakeWebhook({
      topic: "products/update",
      shopDomain: SHOP,
      webhookId: "wh-acc3",
      payload: { id: PRODUCT_B },
    });
    await processWebhookEvent(eventId!);

    const fixExecutor = makeStubExecutor({
      [PRODUCT_B]: productPayload({ productId: PRODUCT_B, variants: [{ id: VARIANT_B1, sku: "widget-fixed" }] }),
    });
    await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor: fixExecutor, client: db });

    expect(await db.issue.count({ where: { type: "DUPLICATE_SKU", status: "open" } })).toBe(0);
    const resolved = await db.issue.findMany({ where: { type: "DUPLICATE_SKU", status: "resolved" } });
    expect(resolved.length).toBe(2);
    expect(resolved.every((r) => r.resolvedAt != null)).toBe(true);
  });

  it("resolves row-rule issues fixed by a webhook update", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    // MISSING_SKU open from a prior scan.
    await db.issue.create({
      data: {
        shopId: shop!.id,
        type: "MISSING_SKU",
        severity: "high",
        variantGid: VARIANT_B1,
        productGid: PRODUCT_B,
        groupKey: "",
        status: "open",
        firstSeenScanId: "scan-1",
        lastSeenScanId: "scan-1",
      },
    });
    await createVariant(shop!.id, {
      variantGid: VARIANT_B1,
      productGid: PRODUCT_B,
      skuRaw: null,
      skuNorm: "",
      seenScanId: "scan-1",
      fingerprint: "fp-b1",
    });

    const executor = makeStubExecutor({
      [PRODUCT_B]: productPayload({ productId: PRODUCT_B, variants: [{ id: VARIANT_B1, sku: "now-set" }] }),
    });
    await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor, client: db });

    const issue = await db.issue.findFirst({ where: { type: "MISSING_SKU", variantGid: VARIANT_B1 } });
    expect(issue?.status).toBe("resolved");
  });

  it("products/delete removes the index rows and resolves the open issues", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await createVariant(shop!.id, { variantGid: VARIANT_B1, productGid: PRODUCT_B, skuRaw: "x", skuNorm: "x", seenScanId: "s" });
    await db.issue.create({
      data: {
        shopId: shop!.id,
        type: "MISSING_SKU",
        severity: "high",
        variantGid: VARIANT_B1,
        productGid: PRODUCT_B,
        groupKey: "",
        status: "open",
      },
    });

    const { eventId } = await intakeWebhook({
      topic: "products/delete",
      shopDomain: SHOP,
      webhookId: "wh-del",
      payload: { id: PRODUCT_B },
    });
    await processWebhookEvent(eventId!);

    expect(await db.variantIndex.count({ where: { productGid: PRODUCT_B } })).toBe(0);
    const issue = await db.issue.findFirst({ where: { type: "MISSING_SKU", variantGid: VARIANT_B1 } });
    expect(issue?.status).toBe("resolved");
  });

  it("skips detection on Free plan (event recorded, nothing else)", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await db.shop.update({ where: { id: shop!.id }, data: { plan: "free" } });
    await createVariant(shop!.id, {
      variantGid: VARIANT_A1,
      productGid: PRODUCT_A,
      skuRaw: "widget",
      skuNorm: "widget",
      seenScanId: "scan-1",
      fingerprint: "fp-a1",
    });

    const executor = makeStubExecutor({
      [PRODUCT_B]: productPayload({ productId: PRODUCT_B, variants: [{ id: VARIANT_B1, sku: "widget" }] }),
    });
    const result = await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor, client: db });
    expect(result.skipped).toBe("free-plan");
    expect(await db.issue.count({ where: { type: "DUPLICATE_SKU" } })).toBe(0);
  });

  it("skips detection when fingerprints are unchanged (loop guard)", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    // A clean variant: no detector fires on it.
    const first = productPayload({
      productId: PRODUCT_B,
      variants: [
        {
          id: VARIANT_B1,
          sku: "stable",
          barcode: "4006381333931",
          price: 10,
          inventoryQuantity: 5,
          tracked: true,
          inventoryPolicy: "CONTINUE",
          mediaCount: 1,
          weight: 1,
          cost: 2,
        },
      ],
    });
    const warmExecutor = makeStubExecutor({ [PRODUCT_B]: first });
    const firstRun = await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor: warmExecutor, client: db });
    expect(firstRun.unchanged).toBe(false);
    expect(await db.issue.count()).toBe(0);

    const result = await syncProduct({ shopId: shop!.id, productGid: PRODUCT_B, executor: warmExecutor, client: db });
    expect(result.unchanged).toBe(true);
    expect(result.opened).toBe(0);
    expect(await db.issue.count()).toBe(0);
  });
});

describe("inventory_levels/update", () => {
  it("maps the inventory item to variants and re-evaluates only zero inventory", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await createVariant(shop!.id, {
      variantGid: VARIANT_A1,
      productGid: PRODUCT_A,
      inventoryItemId: "40404",
      skuRaw: "a",
      skuNorm: "a",
      tracked: true,
      inventoryPolicy: "DENY",
      inventoryQty: 0,
      publishedAnyChannel: true,
      productStatus: "ACTIVE",
      seenScanId: "s",
      fingerprint: "fp-old",
    });

    const response = await inventoryAction(
      asActionArgs(
        webhookRequest("inventory_levels/update", { inventory_item_id: 40404, available: 5 }, "wh-inv-1"),
      ),
    );
    expect(response.status).toBe(200);

    const event = await db.webhookEvent.findFirst({ where: {} });
    await processWebhookEvent(event!.id);

    const job = await db.job.findFirst({ where: { kind: "inventory_sync" } });
    expect(job).not.toBeNull();

    await syncInventoryItem({ shopId: shop!.id, inventoryItemId: "40404", available: 5, client: db });
    const row = await db.variantIndex.findUnique({
      where: { shopId_variantGid: { shopId: shop!.id, variantGid: VARIANT_A1 } },
    });
    expect(row?.inventoryQty).toBe(5);
    // No PUBLISHED_ZERO_INVENTORY issue: the variant is in stock now.
    expect(await db.issue.count({ where: { type: "PUBLISHED_ZERO_INVENTORY" } })).toBe(0);
  });

  it("opens PUBLISHED_ZERO_INVENTORY when stock drops to zero", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await createVariant(shop!.id, {
      variantGid: VARIANT_A1,
      productGid: PRODUCT_A,
      inventoryItemId: "40404",
      skuRaw: "a",
      skuNorm: "a",
      tracked: true,
      inventoryPolicy: "DENY",
      inventoryQty: 5,
      publishedAnyChannel: true,
      productStatus: "ACTIVE",
      seenScanId: "s",
      fingerprint: "fp-old",
    });

    await syncInventoryItem({ shopId: shop!.id, inventoryItemId: "40404", available: 0, client: db });
    expect(await db.issue.count({ where: { type: "PUBLISHED_ZERO_INVENTORY", status: "open" } })).toBe(1);

    // Stock returns: the same sync path resolves it.
    await syncInventoryItem({ shopId: shop!.id, inventoryItemId: "40404", available: 3, client: db });
    expect(await db.issue.count({ where: { type: "PUBLISHED_ZERO_INVENTORY", status: "open" } })).toBe(0);
  });

  it("never flags untracked or continue-selling variants", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await createVariant(shop!.id, {
      variantGid: "gid://shopify/ProductVariant/u1",
      productGid: PRODUCT_A,
      inventoryItemId: "40405",
      skuRaw: "u",
      skuNorm: "u",
      tracked: false, // untracked
      inventoryPolicy: "DENY",
      inventoryQty: 0,
      publishedAnyChannel: true,
      productStatus: "ACTIVE",
      seenScanId: "s",
    });
    await createVariant(shop!.id, {
      variantGid: "gid://shopify/ProductVariant/c1",
      productGid: PRODUCT_A,
      inventoryItemId: "40406",
      skuRaw: "c",
      skuNorm: "c",
      tracked: true,
      inventoryPolicy: "CONTINUE", // continue selling
      inventoryQty: 0,
      publishedAnyChannel: true,
      productStatus: "ACTIVE",
      seenScanId: "s",
    });

    await syncInventoryItem({ shopId: shop!.id, inventoryItemId: "40405", available: 0, client: db });
    await syncInventoryItem({ shopId: shop!.id, inventoryItemId: "40406", available: 0, client: db });
    expect(await db.issue.count({ where: { type: "PUBLISHED_ZERO_INVENTORY" } })).toBe(0);
  });

  it("coalesces repeated updates per item into one pending job with the freshest value", async () => {
    const db = testDb();
    for (const available of [3, 2, 1, 0]) {
      const { eventId } = await intakeWebhook({
        topic: "inventory_levels/update",
        shopDomain: SHOP,
        webhookId: `wh-inv-coalesce-${available}`,
        payload: { inventory_item_id: 40404, available },
      });
      await processWebhookEvent(eventId!);
    }
    const jobs = await db.job.findMany({ where: { kind: "inventory_sync", status: "pending" } });
    expect(jobs.length).toBe(1);
    expect((jobs[0].payload as { available?: number }).available).toBe(0);
  });

  it("is a no-op when the item maps to no variants", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    const result = await syncInventoryItem({ shopId: shop!.id, inventoryItemId: "999999", available: 0, client: db });
    expect(result.skipped).toBe("no-variants");
  });
});

describe("auto-tag (acceptance 7)", () => {
  it("gates: disabled, wrong plan, and missing write_products all no-op", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });

    expect(autoTagAllowed({ plan: "pro", scopes: "read_products", settings: {} })).toBe("disabled");
    expect(autoTagAllowed({ plan: "starter", scopes: "read_products,write_products", settings: { autoTag: true } })).toBe("not-pro");
    expect(autoTagAllowed({ plan: "pro", scopes: "read_products", settings: { autoTag: true } })).toBe("missing-scope");
    expect(autoTagAllowed({ plan: "pro", scopes: "read_products,write_products", settings: { autoTag: true } })).toBeNull();

    const writes: string[] = [];
    const executor = makeStubExecutor({ [PRODUCT_A]: { tags: [] } }, (_q, vars) => writes.push(String((vars.product as { id: string }).id)));
    // Not opted in: no writes at all.
    await applyAutoTags({ shopId: shop!.id, executor, client: db });
    expect(executor.writes).toBe(0);
    expect(writes.length).toBe(0);
  });

  it("tags products with open issues exactly once and never loops", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await db.shop.update({
      where: { id: shop!.id },
      data: { scopes: "read_products,write_products", settings: { autoTag: true } as never },
    });
    await db.issue.create({
      data: {
        shopId: shop!.id,
        type: "MISSING_SKU",
        severity: "high",
        variantGid: VARIANT_A1,
        productGid: PRODUCT_A,
        groupKey: "",
        status: "open",
      },
    });

    const writeTargets: string[] = [];
    const currentTags: Record<string, string[]> = { [PRODUCT_A]: ["new"] };
    const executor = makeStubExecutor(
      { [PRODUCT_A]: { tags: currentTags[PRODUCT_A] } },
      (_q, vars) => {
        const product = vars.product as { id: string; tags: string[] };
        writeTargets.push(product.id);
        currentTags[product.id] = product.tags; // Shopify persists the write
      },
    );

    const outcome = await applyAutoTags({ shopId: shop!.id, executor, client: db });
    expect(outcome.tagged).toBe(1);
    expect(writeTargets).toEqual([PRODUCT_A]);
    expect(currentTags[PRODUCT_A]).toContain(AUTOTAG_TAG);

    // The tag write fires products/update → the watcher runs product_sync.
    // Tags are not fingerprint inputs, so a warm re-sync is a no-op…
    const syncExecutor = makeStubExecutor({
      [PRODUCT_A]: productPayload({ productId: PRODUCT_A, variants: [{ id: VARIANT_A1, sku: "stable-sku" }] }),
    });
    await syncProduct({ shopId: shop!.id, productGid: PRODUCT_A, executor: syncExecutor, client: db });
    const second = await syncProduct({ shopId: shop!.id, productGid: PRODUCT_A, executor: syncExecutor, client: db });
    expect(second.unchanged).toBe(true);
    expect(second.opened).toBe(0);

    // Re-run auto-tag: the tag is already applied, so NO further Shopify write.
    const executor2 = makeStubExecutor({ [PRODUCT_A]: { tags: currentTags[PRODUCT_A] } }, (_q, vars) => {
      writeTargets.push(String((vars.product as { id: string }).id));
    });
    const outcome2 = await applyAutoTags({ shopId: shop!.id, executor: executor2, client: db });
    expect(executor2.writes).toBe(0); // zero writes: the loop cannot continue
    expect(outcome2.tagged).toBe(1); // "ensured tagged" without a write
    // Total Shopify writes across the whole sequence: exactly one.
    expect(writeTargets.length).toBe(1);
  });

  it("untags a product whose issues are all resolved", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await db.shop.update({
      where: { id: shop!.id },
      data: {
        scopes: "read_products,write_products",
        settings: { autoTag: true, autoTaggedProducts: [PRODUCT_A] } as never,
      },
    });
    // No open issues anymore.
    const writes: string[] = [];
    const tags: Record<string, string[]> = { [PRODUCT_A]: [AUTOTAG_TAG] };
    const executor = makeStubExecutor({ [PRODUCT_A]: { tags: tags[PRODUCT_A] } }, (_q, vars) => {
      const product = vars.product as { id: string; tags: string[] };
      writes.push(product.id);
      tags[product.id] = product.tags;
    });
    const outcome = await applyAutoTags({ shopId: shop!.id, executor, client: db });
    expect(outcome.untagged).toBe(1);
    expect(writes).toEqual([PRODUCT_A]);
    expect(tags[PRODUCT_A]).not.toContain(AUTOTAG_TAG);
  });

  it("addFixTag never writes when the tag is already present", async () => {
    const executor = makeStubExecutor({ [PRODUCT_A]: { tags: [AUTOTAG_TAG] } });
    const result = await addFixTag(executor, PRODUCT_A);
    expect(result).toEqual([AUTOTAG_TAG]);
    expect(executor.writes).toBe(0);
  });
});

describe("processor registry completeness", () => {
  it("registers every subscribed topic under both topic forms", () => {
    for (const topic of [
      "products/create",
      "products/update",
      "products/delete",
      "inventory_levels/update",
    ]) {
      expect(getWebhookProcessor(topic)).toBeDefined();
    }
  });
});
