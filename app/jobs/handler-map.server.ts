import type { Logger } from "pino";
import { db } from "../db.server.js";
import { logger } from "../lib/logger.server.js";
import { buildHandlerMap, validatePayload, SCAN_START_SCHEMA, SCAN_POLL_SCHEMA, WEBHOOK_PROCESS_SCHEMA, type JobHandlers } from "./handlers.server.js";
import type { JobHandler } from "./queue.server.js";
import { makeJobExecutor } from "./executor.server.js";
import { processWebhookEvent } from "../webhooks/intake.server.js";
import { registerLifecycleWebhookProcessors } from "../webhooks/processors.server.js";
import { startScan, pollScan } from "../scan/orchestrator.server.js";

/**
 * The production job handler map. One registration per job kind; kinds that
 * do not exist yet (digest_send, telegram_alert, notify_new_issues,
 * product_sync, inventory_sync) are intentionally absent until their phases
 * land — they fail loudly ("no handler registered") instead of pretending
 * to run (no silent drops).
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
  };
}

/** drainJobs handler for the worker and the tick route. */
export function productionDrainHandler(client = db): JobHandler {
  const handlers = buildProductionHandlerMap(client);
  return buildHandlerMap(handlers);
}

