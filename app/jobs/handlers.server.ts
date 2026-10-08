import { z } from "zod";
import type { ClaimedJob, JobHandler } from "./queue.server.js";

/**
 * Job kind → handler registry. Payloads are validated with zod at the boundary;
 * malformed payloads fail the job (recorded, not thrown out of the drain loop).
 */

export const PRODUCT_SYNC_SCHEMA = z.object({
  shopId: z.string(),
  productGid: z.string(),
  source: z.enum(["webhook", "manual"]),
});

export const INVENTORY_SYNC_SCHEMA = z.object({
  shopId: z.string(),
  inventoryItemId: z.number(),
  available: z.number(),
});

export const SCAN_START_SCHEMA = z.object({
  scanId: z.string(),
});

export const SCAN_POLL_SCHEMA = z.object({
  scanId: z.string(),
  attempt: z.number().int().nonnegative().default(0),
});

export const DIGEST_SEND_SCHEMA = z.object({
  shopId: z.string(),
  periodKey: z.string(),
});

export const TELEGRAM_ALERT_SCHEMA = z.object({
  shopId: z.string(),
  scanId: z.string().optional(),
});

export const WEBHOOK_PROCESS_SCHEMA = z.object({
  webhookEventId: z.string(),
});

export type JobKind =
  | "product_sync"
  | "inventory_sync"
  | "scan_start"
  | "scan_poll"
  | "digest_send"
  | "notify_new_issues"
  | "telegram_alert"
  | "webhook_process";

export interface JobHandlers {
  product_sync?: JobHandler;
  inventory_sync?: JobHandler;
  scan_start?: JobHandler;
  scan_poll?: JobHandler;
  digest_send?: JobHandler;
  notify_new_issues?: JobHandler;
  telegram_alert?: JobHandler;
  webhook_process?: JobHandler;
}

/**
 * Build a single handler map from partial handlers. Unregistered kinds fail
 * loudly (failJob records it) rather than being silently skipped.
 */
export function buildHandlerMap(handlers: JobHandlers): JobHandler {
  return async (job: ClaimedJob) => {
    const handler = handlers[job.kind as JobKind];
    if (!handler) {
      throw new Error(`no handler registered for job kind: ${job.kind}`);
    }
    await handler(job);
  };
}

/** Validate a job payload with a schema; throws a normalized error on mismatch. */
export function validatePayload<T>(schema: z.ZodType<T>, payload: Record<string, unknown>): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(
      `invalid payload for ${result.error.errors?.[0]?.path?.join(".") ?? "job"}: ${result.error.message}`,
    );
  }
  return result.data;
}
