import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { activityHistoryDays } from "../billing/gating.js";

export { ACTIVITY_EVENT_KINDS, type ActivityEventKind } from "./events.server.js";

/**
 * Activity feed queries (spec <in_app_alerts>): dashboard "since your last
 * visit" card, the needs-attention list, the weekly summary, and the
 * /app/activity page.
 *
 * All counts derive from stored rows (issues, scans, activity events) — the
 * only mutable "seen" state is shops.activity_seen_at, updated only by an
 * explicit user action ("Mark all as seen"), never by a background job.
 */

export interface SinceLastVisitSummary {
  newIssues: number;
  newHighIssues: number;
  resolvedIssues: number;
  scansFinished: number;
  scansFailed: number;
  /** Null when no completed scan exists on either side of the visit. */
  scoreDelta: number | null;
}

/** The dashboard "Since your last visit" card. */
export async function sinceLastVisit(
  shopId: string,
  plan: string,
  activitySeenAt: Date | null,
  client: PrismaClient = db,
): Promise<SinceLastVisitSummary> {
  const since = activitySeenAt ?? new Date(0);

  // New issues: first seen after the marker and not already resolved (an
  // issue that appeared and was fixed within the window is not news).
  const [newIssues, newHighIssues, resolvedIssues] = await Promise.all([
    client.issue.count({
      where: { shopId, firstSeenAt: { gt: since }, status: { not: "resolved" } },
    }),
    client.issue.count({
      where: { shopId, firstSeenAt: { gt: since }, status: { not: "resolved" }, severity: "high" },
    }),
    client.issue.count({
      where: { shopId, resolvedAt: { gt: since } },
    }),
  ]);

  const scans = await client.scan.findMany({
    where: { shopId, finishedAt: { gt: since } },
    select: { status: true, healthScore: true },
    orderBy: { finishedAt: "asc" },
  });

  const scansFinished = scans.filter((s) => s.status === "completed").length;
  const scansFailed = scans.filter((s) => s.status === "failed").length;

  // Score delta: first completed scan at-or-before the marker vs. the newest
  // one after it. Null when either side is missing.
  const before = await client.scan.findFirst({
    where: { shopId, status: "completed", finishedAt: { lte: since } },
    orderBy: { finishedAt: "desc" },
    select: { healthScore: true },
  });
  const after = scans.find((s) => s.status === "completed" && s.healthScore != null);
  const scoreDelta =
    before?.healthScore != null && after?.healthScore != null
      ? after.healthScore - before.healthScore
      : null;

  return {
    newIssues,
    newHighIssues,
    resolvedIssues,
    scansFinished,
    scansFailed,
    scoreDelta,
  };
}

export interface NeedsAttentionItem {
  issueId: string;
  type: string;
  severity: "high" | "medium" | "low";
  variantGid: string;
  skuNorm: string | null;
  productTitle: string | null;
  firstSeenAt: Date;
  /** Spec <in_app_alerts>: the badge also appears in Needs attention. */
  isNew: boolean;
}

/**
 * Top 5 newest open high-severity issues (spec <in_app_alerts>). Not
 * restricted to since the marker — the marker only drives "New" badges.
 */
export async function needsAttention(
  shopId: string,
  activitySeenAt: Date | null,
  limit = 5,
  client: PrismaClient = db,
): Promise<NeedsAttentionItem[]> {
  // Spec <in_app_alerts>: "Up to 5 newest open high-severity issues" — not
  // just since the marker. The marker only decides the "New" badge.
  const issues = await client.issue.findMany({
    where: {
      shopId,
      severity: "high",
      status: "open",
    },
    orderBy: { firstSeenAt: "desc" },
    take: limit,
  });

  // Display names come from the variant index; issues for deleted variants
  // fall back to the stored details snapshot.
  const variants = issues.length
    ? await client.variantIndex.findMany({
        where: { shopId, variantGid: { in: issues.map((i) => i.variantGid) } },
        select: { variantGid: true, skuNorm: true, productTitle: true },
      })
    : [];
  const byGid = new Map(variants.map((v) => [v.variantGid, v]));

  return issues.map((issue) => {
    const variant = byGid.get(issue.variantGid);
    const details = (issue.details ?? {}) as Record<string, unknown>;
    return {
      issueId: issue.id,
      type: issue.type,
      severity: issue.severity as NeedsAttentionItem["severity"],
      variantGid: issue.variantGid,
      skuNorm: variant?.skuNorm ?? (typeof details.sku === "string" ? details.sku : null),
      productTitle:
        variant?.productTitle ??
        (typeof details.product_title === "string" ? details.product_title : null),
      firstSeenAt: issue.firstSeenAt,
      isNew: activitySeenAt != null && issue.firstSeenAt > activitySeenAt,
    };
  });
}

export interface WeeklySummary {
  newThisWeek: number;
  newLastWeek: number;
  resolvedThisWeek: number;
  resolvedLastWeek: number;
  scoreDelta: number | null;
}

/**
 * Start of the week containing `at`, in the shop's time zone, on the
 * locale's first day of the week (spec <in_app_alerts>). `weekStartsOn`
 * follows Intl.Locale weekInfo: 0=Sunday … 6=Saturday; defaults to Monday.
 */
export function weekStart(
  at: Date,
  timeZone: string,
  weekStartsOn: number = 1,
): Date {
  // Wall-clock calendar date of `at` in the shop's zone, anchored as UTC.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const localMidnightUTC = Date.UTC(get("year"), get("month") - 1, get("day"));
  const weekday = new Date(localMidnightUTC).getUTCDay();
  const shift = (weekday - weekStartsOn + 7) % 7;
  const wall = new Date(localMidnightUTC - shift * 24 * 60 * 60_000);

  // Turn the wall-clock midnight into an instant using the zone's offset at
  // that point; one extra pass guards a week start on a DST transition.
  // offset = local - UTC, so UTC = wall - offset.
  const offset = zoneOffsetMs(wall, timeZone);
  let instant = new Date(wall.getTime() - offset);
  const offset2 = zoneOffsetMs(instant, timeZone);
  if (offset2 !== offset) instant = new Date(wall.getTime() - offset2);
  return instant;
}

/** The zone's offset from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUTC - at.getTime();
}

/** Resolve the locale's first day of the week (Intl.weekInfo where available). */
export function localeWeekStartsOn(locale: string): number {
  try {
    // weekInfo is not in every TS lib target; probe at runtime.
    const parsed = new Intl.Locale(locale) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
    };
    const firstDay = parsed.weekInfo?.firstDay;
    if (typeof firstDay === "number") return firstDay % 7;
  } catch {
    // weekInfo unsupported: fall through to the default.
  }
  return 1;
}

/**
 * The "This week" card (Starter/Pro only). Counts new/resolved issues this
 * week vs. last week and the health-score change since last week's start.
 */
export async function weeklySummary(
  shopId: string,
  options: { at?: Date; timeZone?: string; locale?: string } = {},
  client: PrismaClient = db,
): Promise<WeeklySummary> {
  const at = options.at ?? new Date();
  const timeZone = options.timeZone ?? "UTC";
  const weekStartsOn = localeWeekStartsOn(options.locale ?? "en");
  const thisWeekStart = weekStart(at, timeZone, weekStartsOn);
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60_000);

  const [newThisWeek, newLastWeek, resolvedThisWeek, resolvedLastWeek] = await Promise.all([
    client.issue.count({ where: { shopId, firstSeenAt: { gte: thisWeekStart } } }),
    client.issue.count({
      where: { shopId, firstSeenAt: { gte: lastWeekStart, lt: thisWeekStart } },
    }),
    client.issue.count({ where: { shopId, resolvedAt: { gte: thisWeekStart } } }),
    client.issue.count({
      where: { shopId, resolvedAt: { gte: lastWeekStart, lt: thisWeekStart } },
    }),
  ]);

  // Score at (or nearest before) last week's start vs. the latest completed.
  const before = await client.scan.findFirst({
    where: { shopId, status: "completed", finishedAt: { lt: thisWeekStart } },
    orderBy: { finishedAt: "desc" },
    select: { healthScore: true },
  });
  const latest = await client.scan.findFirst({
    where: { shopId, status: "completed" },
    orderBy: { finishedAt: "desc" },
    select: { healthScore: true },
  });
  const scoreDelta =
    before?.healthScore != null && latest?.healthScore != null
      ? latest.healthScore - before.healthScore
      : null;

  return { newThisWeek, newLastWeek, resolvedThisWeek, resolvedLastWeek, scoreDelta };
}

export interface ActivityFeedItem {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * The /app/activity page: paginated timeline, newest events first, limited
 * to the plan's history window (free 7d, starter 30d, pro 90d). Optional kind
 * filter. `totalOlder` powers the upgrade hint; `page`/`pageCount` power the
 * pager. All in-window rows are fetched once so the pager can clamp pages
 * without a second count round trip.
 */
export const ACTIVITY_PAGE_SIZE = 50;

export async function activityFeed(
  shopId: string,
  plan: string,
  options: { kind?: string; page?: number; pageSize?: number; now?: Date } = {},
  client: PrismaClient = db,
): Promise<{
  items: ActivityFeedItem[];
  totalInWindow: number;
  page: number;
  pageCount: number;
  totalOlder: number;
  windowDays: number;
}> {
  const now = options.now ?? new Date();
  const windowDays = activityHistoryDays(plan);
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60_000);
  const pageSize = options.pageSize ?? ACTIVITY_PAGE_SIZE;

  const where = {
    shopId,
    createdAt: { gte: cutoff },
    ...(options.kind ? { kind: options.kind } : {}),
  };

  const [inWindow, total] = await Promise.all([
    client.activityEvent.count({ where }),
    client.activityEvent.count({ where: { shopId } }),
  ]);

  const pageCount = Math.max(1, Math.ceil(inWindow / pageSize));
  const page = Math.min(Math.max(options.page ?? 1, 1), pageCount);

  const items = await client.activityEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: { id: true, kind: true, payload: true, createdAt: true },
  });

  return {
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      payload: (i.payload ?? {}) as Record<string, unknown>,
      createdAt: i.createdAt,
    })),
    totalInWindow: inWindow,
    page,
    pageCount,
    totalOlder: Math.max(total - inWindow, 0),
    windowDays,
  };
}

/** Update the last-visit marker. Called only by explicit user action. */
export async function markActivitySeen(
  shopId: string,
  client: PrismaClient = db,
  now: Date = new Date(),
): Promise<void> {
  await client.shop.update({
    where: { id: shopId },
    data: { activitySeenAt: now },
  });
}

/** True when any unresolved issue is newer than the marker (badge logic). */
export async function hasUnseenActivity(
  shopId: string,
  activitySeenAt: Date | null,
  client: PrismaClient = db,
): Promise<boolean> {
  const since = activitySeenAt ?? new Date(0);
  const issues = await client.issue.count({
    where: { shopId, firstSeenAt: { gt: since }, status: { not: "resolved" } },
  });
  if (issues > 0) return true;
  const events = await client.activityEvent.count({
    where: { shopId, createdAt: { gt: since }, kind: { in: ["scan_failed", "plan_changed", "over_cap"] } },
  });
  return events > 0;
}
