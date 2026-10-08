import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { db } from "../db.server.js";
import type { Logger } from "pino";

/**
 * Postgres job queue.
 * - Enqueue with optional dedupe key: at most one PENDING job per key
 *   (partial unique index Job_dedupeKey_pending_partial).
 * - Claim with FOR UPDATE SKIP LOCKED: safe under concurrency.
 * - Handlers must be idempotent; retries use exponential backoff.
 * - No Redis, no session-level state: works through PgBouncer transaction mode.
 */

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface EnqueueOptions {
  kind: string;
  payload: Record<string, unknown>;
  shopId?: string | null;
  runAt?: Date;
  dedupeKey?: string | null;
}

export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Client accepted by queue functions: the full PrismaClient or a transaction
 * (Omit<PrismaClient, '$transaction'|...>). Structural on the `job` delegate
 * so both work without widening the whole type.
 */
export type QueueClient = Pick<PrismaClient, "job">;

/** Enqueue a job. If a pending job with the same dedupeKey exists, returns it untouched. */
export async function enqueue(options: EnqueueOptions, client: QueueClient = db) {
  const { kind, payload, shopId, runAt, dedupeKey } = options;
  try {
    return await client.job.create({
      data: {
        kind,
        payload: payload as never,
        shopId: shopId ?? null,
        runAt: runAt ?? new Date(),
        dedupeKey: dedupeKey ?? null,
        attempts: 0,
        status: "pending",
      },
    });
  } catch (error) {
    // Partial unique index hit → a pending duplicate exists; ignore.
    if (dedupeKey && isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * P2025: the row vanished mid-run. shop/redact cascade-deletes the shop's
 * jobs WHILE one of them is running; completing that job is then impossible
 * (and unnecessary) — the erasure is the outcome.
 */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2025"
  );
}

export interface ClaimedJob {
  id: string;
  shopId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** Atomically claim the next runnable job. Returns null when the queue is empty. */
export async function claimJob(
  workerId: string,
  client: PrismaClient = db,
): Promise<ClaimedJob | null> {
  const rows = await client.$queryRaw<
    Array<{
      id: string;
      shopId: string | null;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>
  >`
    WITH next_job AS (
      SELECT id FROM "Job"
      WHERE "status" = 'pending' AND "runAt" <= now()
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Job" SET
      "status" = 'running',
      "lockedAt" = now(),
      "lockedBy" = ${workerId},
      "attempts" = "attempts" + 1
    WHERE "id" IN (SELECT id FROM next_job)
    RETURNING "id", "shopId", "kind", "payload", "attempts"
  `;
  const row = rows[0];
  if (!row) return null;
  return { ...row, maxAttempts: DEFAULT_MAX_ATTEMPTS };
}

export async function completeJob(id: string, client: PrismaClient = db): Promise<void> {
  try {
    await client.job.update({ where: { id }, data: { status: "done", lockedAt: null, lockedBy: null } });
  } catch (error) {
    // shop/redact may have erased this very job row while it ran (P2025).
    if (isRecordNotFound(error)) return;
    throw error;
  }
}

/** Retry with exponential backoff, or fail permanently once attempts are exhausted. */
export async function failJob(
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts">,
  error: unknown,
  client: PrismaClient = db,
): Promise<"retried" | "failed"> {
  const message = error instanceof Error ? error.message : String(error);
  // Never store secrets in last_error: truncate hard.
  const safe = message.slice(0, 500);
  const finish = async (data: Prisma.JobUpdateInput) => {
    try {
      await client.job.update({ where: { id: job.id }, data });
    } catch (updateError) {
      if (isRecordNotFound(updateError)) return;
      throw updateError;
    }
  };
  if (job.attempts >= job.maxAttempts) {
    await finish({ status: "failed", lastError: safe, lockedAt: null, lockedBy: null });
    return "failed";
  }
  const backoffMs = Math.min(60_000, 1000 * 2 ** (job.attempts - 1));
  await finish({
    status: "pending",
    runAt: new Date(Date.now() + backoffMs),
    lastError: safe,
    lockedAt: null,
    lockedBy: null,
  });
  return "retried";
}

/** Release jobs stuck in running (crashed worker) back to pending. */
export async function reclaimStuckJobs(olderThan: Date, client: PrismaClient = db): Promise<number> {
  const result = await client.job.updateMany({
    where: { status: "running", lockedAt: { lt: olderThan } },
    data: { status: "pending", lockedAt: null, lockedBy: null },
  });
  return result.count;
}

export interface DrainOptions {
  logger: Logger;
  maxDrainMs: number;
  workerId?: string;
  handler?: JobHandler;
  client?: PrismaClient;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Drain pending jobs for a bounded time. Returns how many jobs ran. */
export async function drainJobs(options: DrainOptions): Promise<number> {
  const { logger, maxDrainMs, workerId = randomUUID(), handler, client = db } = options;
  if (!handler) return 0;
  const deadline = Date.now() + maxDrainMs;
  let ran = 0;
  while (Date.now() < deadline) {
    const job = await claimJob(workerId, client);
    if (!job) break;
    try {
      await handler(job);
      await completeJob(job.id, client);
      ran += 1;
    } catch (error) {
      const outcome = await failJob(job, error, client);
      logger.warn(
        { jobId: job.id, kind: job.kind, outcome, err: error },
        "job failed; outcome recorded",
      );
    }
  }
  return ran;
}
