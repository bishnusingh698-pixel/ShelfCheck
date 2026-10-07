import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import type { Logger } from "pino";
import { reclaimStuckJobs, drainJobs, type JobHandler } from "./queue.server.js";
import { runDueScheduledScans } from "./scheduler.server.js";
import { runWatchdog } from "./watchdog.server.js";
import { reopenExpiredSnoozes } from "../issues/snooze.server.js";
import { sendDueDigests } from "../notifications/digest.server.js";
import { pruneRateLimitBuckets } from "../lib/rate-limit.server.js";

/**
 * The idempotent tick sequence. Safe to call concurrently and repeatedly:
 * every step is either a no-op when there is nothing to do, or guarded by
 * partial unique indexes / SKIP LOCKED / per-shop locks.
 */
export interface TickResult {
  scansStarted: number;
  digestsSent: number;
  snoozesReopened: number;
  scansFailed: number;
  jobsReclaimed: number;
  jobsRan: number;
  bucketsPruned: number;
}

export interface TickOptions {
  logger: Logger;
  handler?: JobHandler;
  now?: Date;
  client?: PrismaClient;
  maxDrainMs?: number;
}

export async function tick(options: TickOptions): Promise<TickResult> {
  const { logger, handler, now = new Date(), client = db, maxDrainMs = 5000 } = options;

  const scansStarted = await runDueScheduledScans(now, client, logger);
  const digestsSent = await sendDueDigests(now, client, logger);
  const snoozesReopened = await reopenExpiredSnoozes(now, client);
  const scansFailed = await runWatchdog(now, client, logger);
  const jobsReclaimed = await reclaimStuckJobs(new Date(now.getTime() - 10 * 60_000), client);

  const jobsRan = handler
    ? await drainJobs({ logger, maxDrainMs, handler, client })
    : 0;

  const bucketsPruned = await pruneRateLimitBuckets(new Date(now.getTime() - 24 * 60 * 60_000), client);

  const result: TickResult = {
    scansStarted,
    digestsSent,
    snoozesReopened,
    scansFailed,
    jobsReclaimed,
    jobsRan,
    bucketsPruned,
  };
  logger.info(result, "tick complete");
  return result;
}
