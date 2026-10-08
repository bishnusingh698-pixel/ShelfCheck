import type { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger.server.js";
import { registerWebhookProcessor, type StoredWebhookEvent } from "./intake.server.js";
import { uninstallShop } from "./uninstall.server.js";
import { acknowledgeCustomerTopic, redactShop } from "./redact.server.js";
import { refreshShopPlan } from "../billing/subscription.server.js";
import { makeJobExecutor } from "../jobs/executor.server.js";
import { parseAndDetect, handleFailedOperation } from "../scan/orchestrator.server.js";
import { readBulkOperation } from "../scan/bulk-operation.server.js";
import { syncProduct, removeProductVariants, PRODUCT_DEBOUNCE_MS } from "./product-sync.server.js";
import { syncInventoryItem, INVENTORY_COALESCE_MS } from "./inventory-sync.server.js";
import { enqueue, isUniqueViolation } from "../jobs/queue.server.js";

/**
 * Webhook topic processors (the async half of the intake). Registered once at
 * module load from the production handler map (jobs/handler-map.server.ts).
 *
 * Handlers must be idempotent: Shopify retries deliveries, the dedupe key
 * only guards PENDING jobs, and the same event may be processed after a
 * crash-reclaim.
 */

export async function handleScopesUpdate(event: StoredWebhookEvent, client: PrismaClient): Promise<void> {
  const current = Array.isArray(event.payload.current) ? event.payload.current : [];
  const scopes = current.filter((s): s is string => typeof s === "string");
  const shop = await client.shop.findUnique({ where: { shopDomain: event.shopDomain } });
  if (!shop) return;

  const settings = (shop.settings ?? {}) as Record<string, unknown>;
  const hasWriteProducts = scopes.includes("write_products");
  const nextSettings =
    !hasWriteProducts && settings.autoTag === true
      ? { ...settings, autoTag: false }
      : settings;

  await client.shop.update({
    where: { id: shop.id },
    data: { scopes: scopes.join(","), settings: nextSettings as never },
  });
  if (!hasWriteProducts && settings.autoTag === true) {
    logger.info({ shopId: shop.id }, "auto-tag disabled: write_products scope removed");
  }
}

export async function handleSubscriptionUpdate(event: StoredWebhookEvent, client: PrismaClient): Promise<void> {
  const shop = await client.shop.findUnique({ where: { shopDomain: event.shopDomain } });
  if (!shop) return;
  // The live read is authoritative; the payload's status can lag (PENDING).
  try {
    const executor = await makeJobExecutor(shop.id, client);
    await refreshShopPlan(shop.id, executor, client);
    logger.info({ shopId: shop.id }, "plan refreshed from app_subscriptions/update");
  } catch (error) {
    // Uninstalled shops (or expired tokens) cannot refresh; keep the cached
    // plan. Gates read the cache, so behavior stays consistent.
    logger.warn({ err: error, shopId: shop.id }, "subscription plan refresh failed");
  }
}

export async function handleBulkOperationFinish(event: StoredWebhookEvent, client: PrismaClient): Promise<void> {
  const operationId = typeof event.payload.id === "string" ? event.payload.id : null;
  if (!operationId) return;
  const scan = await client.scan.findFirst({
    where: { bulkOperationId: operationId, status: { in: ["running", "parsing"] } },
  });
  if (!scan) return; // already finished (webhook vs poll race — loser no-ops)

  const executor = await makeJobExecutor(scan.shopId, client);
  const status = await readBulkOperation(executor, operationId);
  if (!status) return;
  if (status.status === "COMPLETED") {
    await parseAndDetect({ shopId: scan.shopId, scanId: scan.id, status, client, logger });
  } else if (status.status === "FAILED" || status.status === "CANCELED" || status.status === "EXPIRED") {
    await handleFailedOperation(scan.shopId, scan.id, status, client);
  }
  // Non-terminal statuses are impossible in a finish webhook but harmless.
}

const PRODUCT_TOPICS = new Set(["products/create", "products/update", "products/delete"]);

/**
 * Enqueue a debounced product_sync job. The dedupe key holds one PENDING job
 * per product; when a burst arrives, the pending job's run_at is pushed out
 * so the LAST write wins and rapid admin edits collapse into one sync.
 */
async function enqueueDebouncedProductSync(
  shopId: string,
  productGid: string,
  client: PrismaClient,
  now: Date,
): Promise<void> {
  const runAt = new Date(now.getTime() + PRODUCT_DEBOUNCE_MS);
  try {
    await enqueue(
      {
        kind: "product_sync",
        payload: { shopId, productGid, source: "webhook" },
        shopId,
        runAt,
        dedupeKey: `product_sync:${shopId}:${productGid}`,
      },
      client,
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  // Sliding debounce: postpone the pending job if the burst continues.
  await client.job.updateMany({
    where: { dedupeKey: `product_sync:${shopId}:${productGid}`, status: "pending", runAt: { lt: runAt } },
    data: { runAt },
  });
}

/** products/* processor: debounce per product, then the product_sync job syncs. */
export async function handleProductTopic(event: StoredWebhookEvent, client: PrismaClient): Promise<void> {
  const shop = await client.shop.findUnique({ where: { shopDomain: event.shopDomain } });
  if (!shop) return;
  // The topic arrives in human form ("products/delete") or the library's
  // storage form ("PRODUCTS_DELETE") — see intake.server.ts.
  const isDelete =
    event.topic === "products/delete" || event.topic === "PRODUCTS_DELETE" || event.topic === "PRODUCTS_DELETE".toLowerCase();
  const productGid = productGidFromPayload(event.payload);
  if (!productGid) return;

  if (isDelete) {
    // Deletion needs no Shopify read-back: drop the rows and resolve issues.
    await removeProductVariants({ shopId: shop.id, productGid, client });
    return;
  }
  await enqueueDebouncedProductSync(shop.id, productGid, client, new Date());
}

/**
 * REST webhook payloads carry a numeric product id (and optionally
 * admin_graphql_api_id); the sync needs the GID. Accepts both shapes.
 */
export function productGidFromPayload(payload: Record<string, unknown>): string | null {
  const explicit = payload.admin_graphql_api_id;
  if (typeof explicit === "string" && explicit.startsWith("gid://")) return explicit;
  const id = payload.id;
  if (typeof id === "string" && id.startsWith("gid://")) return id;
  if (typeof id === "number" && Number.isInteger(id)) return `gid://shopify/Product/${id}`;
  if (typeof id === "string" && /^\d+$/.test(id)) return `gid://shopify/Product/${id}`;
  return null;
}

/** inventory_levels/update processor: coalesce per item, throttle per shop. */
export async function handleInventoryLevelUpdate(
  event: StoredWebhookEvent,
  client: PrismaClient,
): Promise<void> {
  const shop = await client.shop.findUnique({ where: { shopDomain: event.shopDomain } });
  if (!shop) return;
  const inventoryItemId =
    typeof event.payload.inventory_item_id === "number"
      ? String(event.payload.inventory_item_id)
      : typeof event.payload.inventory_item_id === "string"
        ? event.payload.inventory_item_id
        : null;
  const available =
    typeof event.payload.available === "number"
      ? event.payload.available
      : Number.isFinite(Number(event.payload.available))
        ? Number(event.payload.available)
        : null;
  if (!inventoryItemId) return;

  const runAt = new Date(Date.now() + INVENTORY_COALESCE_MS);
  try {
    await enqueue(
      {
        kind: "inventory_sync",
        payload: { shopId: shop.id, inventoryItemId, available },
        shopId: shop.id,
        runAt,
        dedupeKey: `inventory_sync:${shop.id}:${inventoryItemId}`,
      },
      client,
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  // Coalesce: keep the freshest available value on the pending job.
  await client.job.updateMany({
    where: {
      dedupeKey: `inventory_sync:${shop.id}:${inventoryItemId}`,
      status: "pending",
    },
    data: { payload: { shopId: shop.id, inventoryItemId, available } as never, runAt },
  });
}

/**
 * Run one debounced product sync (the product_sync job handler calls this).
 * The executor is injected so tests can stub Shopify.
 */
export async function runProductSync(
  shopId: string,
  productGid: string,
  client: PrismaClient,
): Promise<void> {
  const executor = await makeJobExecutor(shopId, client);
  await syncProduct({ shopId, productGid, executor, client });
}

/** Run one coalesced inventory sync (the inventory_sync job handler). */
export async function runInventorySync(
  shopId: string,
  inventoryItemId: string,
  available: number | null,
  client: PrismaClient,
): Promise<void> {
  await syncInventoryItem({ shopId, inventoryItemId, available, client });
}

/** Install every lifecycle + watcher processor. Called by the production handler map. */
export function registerLifecycleWebhookProcessors(): void {
  registerWebhookProcessor("app/uninstalled", async (event, client) => {
    await uninstallShop(event.shopDomain, client);
  });
  registerWebhookProcessor("app/scopes_update", handleScopesUpdate);
  registerWebhookProcessor("app_subscriptions/update", handleSubscriptionUpdate);
  registerWebhookProcessor("shop/redact", async (event, client) => {
    await redactShop(event.shopDomain, client);
  });
  registerWebhookProcessor("customers/data_request", acknowledgeCustomerTopic);
  registerWebhookProcessor("customers/redact", acknowledgeCustomerTopic);
  registerWebhookProcessor("bulk_operations/finish", handleBulkOperationFinish);
  for (const topic of PRODUCT_TOPICS) {
    registerWebhookProcessor(topic, handleProductTopic);
  }
  registerWebhookProcessor("inventory_levels/update", handleInventoryLevelUpdate);
}
