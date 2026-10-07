import type { PrismaClient } from "@prisma/client";

/**
 * Snooze lifecycle: snooze (7/30/90 days), unsnooze, reopen expired.
 * Expired snoozes reopen automatically on each tick (no per-row timers).
 */

export const SNOOZE_DAYS = [7, 30, 90] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

export function snoozeUntil(days: SnoozeDays, now = new Date()): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

export function isSnoozeDays(value: number): value is SnoozeDays {
  return (SNOOZE_DAYS as readonly number[]).includes(value);
}

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
