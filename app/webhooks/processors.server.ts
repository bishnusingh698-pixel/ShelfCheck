import type { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger.server.js";
import { registerWebhookProcessor, type StoredWebhookEvent } from "./intake.server.js";
import { uninstallShop } from "./uninstall.server.js";
import { acknowledgeCustomerTopic, redactShop } from "./redact.server.js";
import { refreshShopPlan } from "../billing/subscription.server.js";
import { makeJobExecutor } from "../jobs/executor.server.js";
import { parseAndDetect, handleFailedOperation } from "../scan/orchestrator.server.js";
import { readBulkOperation } from "../scan/bulk-operation.server.js";

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

/** Install every lifecycle processor. Called by the production handler map. */
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
}
