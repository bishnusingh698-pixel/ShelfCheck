import type { Logger } from "pino";
import { db } from "../db.server.js";
import { logger } from "../lib/logger.server.js";
import { buildHandlerMap, validatePayload, SCAN_START_SCHEMA, SCAN_POLL_SCHEMA, WEBHOOK_PROCESS_SCHEMA, PRODUCT_SYNC_SCHEMA, INVENTORY_SYNC_SCHEMA, AUTOTAG_RUN_SCHEMA, DIGEST_SEND_SCHEMA, type JobHandlers } from "./handlers.server.js";
import type { JobHandler } from "./queue.server.js";
import { makeJobExecutor } from "./executor.server.js";
import { processWebhookEvent } from "../webhooks/intake.server.js";
import { registerLifecycleWebhookProcessors, runProductSync } from "../webhooks/processors.server.js";
import { startScan, pollScan } from "../scan/orchestrator.server.js";
import { syncInventoryItem } from "../webhooks/inventory-sync.server.js";
import { applyAutoTags } from "../autotag/autotag.server.js";
import { runDigestSend } from "../notifications/digest.server.js";

/**
 * The production job handler map. One registration per job kind; kinds that
 * do not exist yet (telegram_alert, notify_new_issues) are intentionally
 * absent until their phases land — they fail loudly ("no handler
 * registered") instead of pretending to run (no silent drops).
 *
 * Handlers are idempotent: the queue guarantees at-least-once delivery
 * (crash reclaim), so every handler tolerates a second run.
 */

let registered = false;
function ensureProcessors(): void {
  if (registered) return;
  registerLifecycleWebhookProcessors();
  registered = true;
}

export function buildProductionHandlerMap(client = db): JobHandlers {
  ensureProcessors();
  return {
    webhook_process: async (job) => {
      const payload = validatePayload(WEBHOOK_PROCESS_SCHEMA, job.payload);
      await processWebhookEvent(payload.webhookEventId, client);
    },
    scan_start: async (job) => {
      const payload = validatePayload(SCAN_START_SCHEMA, job.payload);
      if (!job.shopId) throw new Error("scan_start requires shopId");
      const makeExecutor = () => makeJobExecutor(job.shopId as string, client);
      await startScan({
        shopId: job.shopId,
        scanId: payload.scanId,
        makeExecutor,
        client,
        logger: logger as Logger,
      });
    },
    scan_poll: async (job) => {
      const payload = validatePayload(SCAN_POLL_SCHEMA, job.payload);
      if (!job.shopId) throw new Error("scan_poll requires shopId");
      const makeExecutor = () => makeJobExecutor(job.shopId as string, client);
      await pollScan({
        shopId: job.shopId,
        scanId: payload.scanId,
        makeExecutor,
        client,
        logger: logger as Logger,
      });
    },
    product_sync: async (job) => {
      const payload = validatePayload(PRODUCT_SYNC_SCHEMA, job.payload);
      await runProductSync(payload.shopId, payload.productGid, client);
    },
    inventory_sync: async (job) => {
      const payload = validatePayload(INVENTORY_SYNC_SCHEMA, job.payload);
      await syncInventoryItem({
        shopId: payload.shopId,
        inventoryItemId: String(payload.inventoryItemId),
        available: payload.available ?? null,
        client,
      });
    },
    autotag_run: async (job) => {
      const payload = validatePayload(AUTOTAG_RUN_SCHEMA, job.payload);
      if (!job.shopId) throw new Error("autotag_run requires shopId");
      const executor = await makeJobExecutor(job.shopId, client);
      await applyAutoTags({ shopId: payload.shopId, executor, client });
    },
    digest_send: async (job) => {
      const payload = validatePayload(DIGEST_SEND_SCHEMA, job.payload);
      // runDigestSend is idempotent per period (NotificationLog unique key):
      // a crash-reclaimed retry is a no-op once the row is terminal.
      await runDigestSend(payload.shopId, payload.periodKey, { client, logger: logger as Logger });
    },
  };
}

/** drainJobs handler for the worker and the tick route. */
export function productionDrainHandler(client = db): JobHandler {
  const handlers = buildProductionHandlerMap(client);
  return buildHandlerMap(handlers);
}

