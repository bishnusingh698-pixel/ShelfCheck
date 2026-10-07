import type { PrismaClient } from "@prisma/client";
import { enqueue } from "../jobs/queue.server.js";

/**
 * Digest selection and due computation. Idempotent per period via the
 * NotificationLog unique key (shopId, channel, kind, periodKey).
 */

/** ISO week period key in the shop's time zone, e.g. 2026-W41. */
export function digestPeriodKey(now: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour12: false });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const idx = dayNames.indexOf(get("weekday"));
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const utcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const monday = idx <= 0 ? utcMidnight : new Date(utcMidnight.getTime() - idx * 86_400_000);
  // ISO week number
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = Math.ceil(((thursday.getTime() - jan4.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface DigestSelection {
  newIssues: Array<{
    id: string;
    type: string;
    severity: string;
  }>;
  totalOpen: number;
  periodKey: string;
  skipReason?: "disabled" | "not-pro-plan" | "no-recipient" | "nothing-new" | "already-sent";
}

/** Which shops are due a digest right now (day+hour match in the shop's TZ, Starter/Pro only)? */
export async function sendDueDigests(now: Date, client: PrismaClient, logger: { info: (o: object, m: string) => void; debug: (o: object, m: string) => void }): Promise<number> {
  const shops = await client.shop.findMany({ where: { uninstalledAt: null } });
  let sent = 0;
  for (const shop of shops) {
    if (shop.plan === "free") continue;
    const settings = (shop.settings ?? {}) as {
      digest?: { enabled?: boolean; email?: string; day?: number; hour?: number };
    };
    const digest = settings.digest;
    if (!digest?.enabled || !digest.email) continue;
    const timeZone = shop.timezone ?? "UTC";
    const day = digest.day ?? 0; // default: Sunday
    const hour = digest.hour ?? 9; // default: 09:00 local
    const localNow = new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
    const localDay = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      localNow.find((p) => p.type === "weekday")?.value ?? "",
    );
    const localHour = Number(localNow.find((p) => p.type === "hour")?.value ?? "0");
    if (localDay !== day || localHour !== hour) continue;
    const periodKey = digestPeriodKey(now, timeZone);
    const already = await client.notificationLog.count({
      where: { shopId: shop.id, channel: "email", kind: "digest", periodKey },
    });
    if (already > 0) {
      logger.debug({ shopId: shop.id, periodKey }, "digest already sent for period");
      continue;
    }
    await enqueue(
      {
        kind: "digest_send",
        payload: { shopId: shop.id, periodKey },
        shopId: shop.id,
        dedupeKey: `digest:${shop.id}:${periodKey}`,
      },
      client,
    );
    sent += 1;
  }
  logger.info({ sent }, "digest jobs enqueued");
  return sent;
}

/** Select digest content: issues first seen since the last digest + total open. */
export async function selectDigestContent(
  shopId: string,
  periodKey: string,
  client: PrismaClient,
  lastDigestAt: Date | null,
): Promise<DigestSelection> {
  const totalOpen = await client.issue.count({ where: { shopId, status: "open" } });
  const newIssues = await client.issue.findMany({
    where: {
      shopId,
      status: "open",
      firstSeenAt: lastDigestAt ? { gt: lastDigestAt } : undefined,
    },
    orderBy: { firstSeenAt: "desc" },
    take: 5,
    select: { id: true, type: true, severity: true },
  });
  return { newIssues, totalOpen, periodKey };
}
