import type { PrismaClient } from "@prisma/client";

import { snoozeUntil, type SnoozeDays } from "./snooze.js";

export { SNOOZE_DAYS, isSnoozeDays, snoozeUntil } from "./snooze.js";
export type { SnoozeDays } from "./snooze.js";

/**
 * Snooze lifecycle: snooze (7/30/90 days), unsnooze, reopen expired.
 * Expired snoozes reopen automatically on each tick (no per-row timers).
 */

export async function snoozeIssue(
  shopId: string,
  issueId: string,
  days: SnoozeDays,
  client: PrismaClient,
  now = new Date(),
): Promise<void> {
  await client.issue.update({
    where: { id: issueId, shopId }, // shopId in where: enforced tenant scoping
    data: { status: "snoozed", snoozedUntil: snoozeUntil(days, now) },
  });
}

export async function unsnoozeIssue(shopId: string, issueId: string, client: PrismaClient): Promise<void> {
  await client.issue.update({
    where: { id: issueId, shopId },
    data: { status: "open", snoozedUntil: null },
  });
}

/** Reopen all snoozes that expired. Idempotent: only touches rows past their deadline. */
export async function reopenExpiredSnoozes(now: Date, client: PrismaClient): Promise<number> {
  const result = await client.issue.updateMany({
    where: { status: "snoozed", snoozedUntil: { lt: now } },
    data: { status: "open", snoozedUntil: null },
  });
  return result.count;
}
