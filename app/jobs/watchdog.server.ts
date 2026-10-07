import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

/** Watchdog: fails scans stuck for more than 60 minutes. */
export const SCAN_STUCK_MINUTES = 60;

export async function runWatchdog(now: Date, client: PrismaClient, logger: Logger): Promise<number> {
  const cutoff = new Date(now.getTime() - SCAN_STUCK_MINUTES * 60_000);
  const result = await client.scan.updateMany({
    where: {
      status: { in: ["queued", "running", "parsing"] },
      OR: [{ createdAt: { lt: cutoff } }, { startedAt: { lt: cutoff } }],
    },
    data: { status: "failed", errorCode: "watchdog_timeout", finishedAt: now },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count, cutoff }, "watchdog failed stuck scans");
  }
  return result.count;
}
