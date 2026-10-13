import { registerLifecycleWebhookProcessors, runProductSync, runInventorySync } from "../webhooks/processors.server.js";
import type { Logger } from "pino";
import { db } from "../db.server.js";
import { logger } from "../lib/logger.server.js";
import { buildHandlerMap, validatePayload, SCAN_START_SCHEMA, SCAN_POLL_SCHEMA, WEBHOOK_PROCESS_SCHEMA, PRODUCT_SYNC_SCHEMA, INVENTORY_SYNC_SCHEMA, AUTOTAG_RUN_SCHEMA, type JobHandlers } from "./handlers.server.js";
import type { JobHandler } from "./queue.server.js";
import { makeJobExecutor } from "./executor.server.js";
import { processWebhookEvent } from "../webhooks/intake.server.js";
import { startScan, pollScan } from "../scan/orchestrator.server.js";
import { pollDelayMs } from "../scan/bulk-operation.server.js";
import { enqueue } from "./queue.server.js";
import { applyAutoTags } from "../autotag/autotag.server.js";

/**
 * The production job handler map. One registration per job kind. Handlers are
 * idempotent: the queue guarantees at-least-once delivery (crash reclaim), so
 * every handler tolerates a second run.
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
      const result = await pollScan({
        shopId: job.shopId,
        scanId: payload.scanId,
        makeExecutor,
        client,
        logger: logger as Logger,
      });
      // Keep polling with exponential backoff (5 s start, 60 s cap) until the
      // scan is terminal; the watchdog fails anything stuck for 60 minutes.
      if (!result.terminal) {
        const attempt = (payload.attempt ?? 0) + 1;
        await enqueue(
          {
            kind: "scan_poll",
            payload: { scanId: payload.scanId, attempt },
            shopId: job.shopId,
            runAt: new Date(Date.now() + pollDelayMs(attempt)),
            dedupeKey: `scan_poll:${payload.scanId}`,
          },
          client,
        );
      }
    },
    product_sync: async (job) => {
      const payload = validatePayload(PRODUCT_SYNC_SCHEMA, job.payload);
      await runProductSync(payload.shopId, payload.productGid, client);
    },
    inventory_sync: async (job) => {
      const payload = validatePayload(INVENTORY_SYNC_SCHEMA, job.payload);
      // runInventorySync wraps syncInventoryItem and records the coalesced
      // issues_changed activity event when inventory changes open/resolve
      // issues (matching the product_sync path).
      await runInventorySync(
        payload.shopId,
        String(payload.inventoryItemId),
        payload.available ?? null,
        client,
      );
    },
    autotag_run: async (job) => {
      const payload = validatePayload(AUTOTAG_RUN_SCHEMA, job.payload);
      if (!job.shopId) throw new Error("autotag_run requires shopId");
      const executor = await makeJobExecutor(job.shopId, client);
      await applyAutoTags({ shopId: payload.shopId, executor, client });
    },
  };
}

/** drainJobs handler for the worker and the tick route. */
export function productionDrainHandler(client = db): JobHandler {
  const handlers = buildProductionHandlerMap(client);
  return buildHandlerMap(handlers);
}

