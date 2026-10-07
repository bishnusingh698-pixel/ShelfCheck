import { z } from "zod";
import { adminGraphQL, unwrapData } from "../lib/admin-graphql.server.js";
import type { AdminGraphQLExecutor } from "../lib/admin-graphql.server.js";
import { BULK_RUN_MUTATION, BULK_STATUS_QUERY, isTerminal } from "./bulk-query.js";
import type { Logger } from "pino";

/**
 * Bulk operation lifecycle: start, track by ID (never currentBulkOperation),
 * retry with backoff. The JSONL URL is only read once, immediately (result
 * files expire after 7 days, and we never assume the instance stays awake).
 */

const runResponseSchema = z.object({
  bulkOperationRunQuery: z.object({
    bulkOperation: z
      .object({
        id: z.string(),
        status: z.string(),
        objectCount: z.number().nullable().optional(),
      })
      .nullable(),
    userErrors: z.array(z.object({ field: z.array(z.string()).nullable().optional(), message: z.string() })),
  }),
});

const statusResponseSchema = z.object({
  bulkOperation: z
    .object({
      id: z.string(),
      status: z.string(),
      objectCount: z.number().nullable().optional(),
      url: z.string().nullable().optional(),
      partialDataUrl: z.string().nullable().optional(),
      errorCode: z.string().nullable().optional(),
      fileSize: z.number().nullable().optional(),
    })
    .nullable(),
});

export interface StartedOperation {
  id: string;
  status: string;
}

/** Start a bulk operation. Throws with the userErrors text when rejected. */
export async function startBulkOperation(
  executor: AdminGraphQLExecutor,
  query: string,
  logger: Logger,
): Promise<StartedOperation> {
  const response = await adminGraphQL(executor, BULK_RUN_MUTATION, { query }, {
    onRetry: (info) => logger.warn(info, "bulk start throttled; backing off"),
  });
  const data = unwrapData(response, (d) => runResponseSchema.parse(d));
  if (data.bulkOperationRunQuery.userErrors.length > 0) {
    throw new Error(
      `bulkOperationRunQuery userErrors: ${data.bulkOperationRunQuery.userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  const op = data.bulkOperationRunQuery.bulkOperation;
  if (!op) throw new Error("bulkOperationRunQuery returned no operation");
  return { id: op.id, status: op.status };
}

export interface OperationStatus {
  id: string;
  status: string;
  objectCount: number | null;
  url: string | null;
  partialDataUrl: string | null;
  errorCode: string | null;
}

/** Read operation status by ID (polling fallback path). */
export async function readBulkOperation(
  executor: AdminGraphQLExecutor,
  id: string,
): Promise<OperationStatus | null> {
  const response = await adminGraphQL(executor, BULK_STATUS_QUERY, { id }, {});
  const data = unwrapData(response, (d) => statusResponseSchema.parse(d));
  const op = data.bulkOperation;
  if (!op) return null;
  return {
    id: op.id,
    status: op.status,
    objectCount: op.objectCount ?? null,
    url: op.url ?? null,
    partialDataUrl: op.partialDataUrl ?? null,
    errorCode: op.errorCode ?? null,
  };
}

export { isTerminal };

/** Polling fallback backoff: 5 s start, ×2, capped at 60 s (spec §scan_pipeline). */
export function pollDelayMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Download the result file as a stream. The URL is a signed, short-lived
 * link; we fetch immediately and pass the raw stream to the JSONL parser.
 */
export async function fetchResultStream(url: string): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`result file download failed: HTTP ${response.status}`);
  }
  return response.body;
}
