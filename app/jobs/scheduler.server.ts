import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { planLimits } from "../billing/plans.js";
import { canScanNow } from "../billing/gating.js";
import { enqueue, isUniqueViolation } from "./queue.server.js";

/**
 * Scheduler: computes "due" scheduled scans and digests in the SHOP's time zone.
 * Free: 1 scan per calendar month. Starter: weekly. Pro: daily.
 * A scheduled scan is due when the current period's scan has not run yet and
 * the configured hour has passed on the configured day.
 */

export interface ScheduledScanDecision {
  due: boolean;
  reason: "not-installed" | "over-cap-plan" | "already-scanned-this-period" | "before-schedule-time" | "due";
}

/** Calendar-month boundary in the shop's IANA time zone (Free plan). */
export function calendarMonthStart(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return new Date(Date.UTC(get("year"), get("month") - 1, 1, 0, 0, 0));
}

/** Start of the current ISO week (Monday 00:00) in the shop's time zone (Starter). */
export function weekStart(now: Date, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const idx = dayNames.indexOf(get("weekday"));
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const utcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const shifted = idx <= 0 ? utcMidnight : new Date(utcMidnight.getTime() - idx * 86_400_000);
  return shifted;
}

/** Midnight of the current local day (Pro: daily scheduled scan). */
export function localDayStart(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0));
}

/** Default scheduled scan cadence per plan: Free monthly (1st, 02:00), Starter Monday 02:00, Pro daily 02:00. */
export function scheduledScanPeriodStart(now: Date, plan: string, timeZone: string): Date {
  if (plan === "pro") return localDayStart(now, timeZone);
  if (plan === "starter") return weekStart(now, timeZone);
  return calendarMonthStart(now, timeZone);
}

/** Is a scheduled scan due for this shop right now? */
export function isScheduledScanDue(
  shop: {
    plan: string;
    timezone: string | null;
    uninstalledAt: Date | null;
    lastScanAt: Date | null;
    settings: unknown;
  },
  scansSincePeriodStart: number,
  now: Date,
): ScheduledScanDecision {
  if (shop.uninstalledAt) return { due: false, reason: "not-installed" };
  const timeZone = shop.timezone ?? "UTC";
  const periodStart = scheduledScanPeriodStart(now, shop.plan, timeZone);
  if (scansSincePeriodStart > 0) return { due: false, reason: "already-scanned-this-period" };
  const limits = planLimits(shop.plan);
  const settings = (shop.settings ?? {}) as { scheduledHour?: number };
  const hour = typeof settings.scheduledHour === "number" ? settings.scheduledHour : 2;
  // Due only at/after the configured hour of the configured day (we treat period start day as the day).
  const dueAt = new Date(periodStart.getTime() + hour * 3_600_000);
  if (now < dueAt) return { due: false, reason: "before-schedule-time" };
  void limits;
  return { due: true, reason: "due" };
}

/** Enqueue scheduled scans for every shop that is due. Returns how many were enqueued. */
export async function runDueScheduledScans(
  now: Date,
  client: PrismaClient,
  logger: Logger,
): Promise<number> {
  const shops = await client.shop.findMany({ where: { uninstalledAt: null } });
  let started = 0;
  for (const shop of shops) {
    const timeZone = shop.timezone ?? "UTC";
    const periodStart = scheduledScanPeriodStart(now, shop.plan, timeZone);
    const recent = await client.scan.count({
      where: {
        shopId: shop.id,
        trigger: "scheduled",
        createdAt: { gte: periodStart },
      },
    });
    const decision = isScheduledScanDue(shop, recent, now);
    if (!decision.due) continue;
    const gating = canScanNow(
      {
        plan: shop.plan,
        lastScanAt: shop.lastScanAt,
        scansToday: await client.scan.count({
          where: { shopId: shop.id, createdAt: { gte: localDayStart(now, timeZone) } },
        }),
      },
      "scheduled",
      now,
    );
    if (!gating.allowed) {
      logger.debug({ shopId: shop.id, reason: gating.reason }, "scheduled scan skipped");
      continue;
    }
    try {
      const scan = await client.scan.create({
        data: { shopId: shop.id, trigger: "scheduled", status: "queued" },
      });
      await enqueue(
        { kind: "scan_start", payload: { scanId: scan.id }, shopId: shop.id, dedupeKey: `scan_start:${scan.id}` },
        client,
      );
      started += 1;
    } catch (error) {
      // Concurrent ticks race here; the partial unique index
      // (one active scan per shop) makes the loser fail with P2002.
      // That is exactly the guard working: only one scan gets created.
      if (isUniqueViolation(error)) {
        logger.debug({ shopId: shop.id }, "scheduled scan already started by a concurrent tick");
        continue;
      }
      throw error;
    }
  }
  return started;
}
