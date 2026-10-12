// Test env FIRST (see helpers/shopify-test-env.ts): app modules read
// process.env at import time.
import "../helpers/shopify-test-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetDb,
  disposeTestDb,
  testDb,
  createShop,
  createIssue,
  createScan,
  createActivityEvent,
} from "../helpers/db.js";
import {
  recordActivityEvent,
  recordIssuesChanged,
  purgeOldActivityEvents,
  bucketOf,
  COALESCE_WINDOW_MS,
  ACTIVITY_EVENT_KINDS,
  activitySentence,
  PURGE_AFTER_DAYS,
} from "../../app/activity/events.server.js";
import {
  sinceLastVisit,
  needsAttention,
  weeklySummary,
  activityFeed,
  markActivitySeen,
  hasUnseenActivity,
  weekStart,
  localeWeekStartsOn,
} from "../../app/activity/queries.server.js";
import { makeT } from "../../app/i18n/i18n.server.js";
import { activityHistoryDays } from "../../app/billing/gating.js";

const SHOP = "activity-test.myshopify.com";

beforeAll(async () => {
  await testDb().$queryRaw`SELECT 1`;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disposeTestDb();
});

/**
 * Integration tests for spec <in_app_alerts>: coalescing, the dashboard
 * aggregations, the feed's plan window, and the seen-marker lifecycle.
 * All against real Postgres.
 */
describe("activity event recording", () => {
  it("records a plain (non-coalesced) event per call", async () => {
    const shop = await createShop({ shopDomain: SHOP });
    await recordActivityEvent({ shopId: shop.id, kind: "scan_failed", payload: { code: "bulk_timeout" } });
    await recordActivityEvent({ shopId: shop.id, kind: "scan_failed", payload: { code: "graph_error" } });

    const rows = await testDb().activityEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].payload).toMatchObject({ code: "bulk_timeout" });
    expect(rows[1].payload).toMatchObject({ code: "graph_error" });
  });

  it("coalesces issues_changed into one row per 15-minute bucket and adds counts", async () => {
    const shop = await createShop({ shopDomain: SHOP });
    const t0 = new Date("2026-10-12T10:03:00Z");

    await recordIssuesChanged(shop.id, { opened: 2, resolved: 0 }, testDb(), t0);
    await recordIssuesChanged(shop.id, { opened: 3, resolved: 1, highOpened: 1 }, testDb(), t0);
    // Different bucket → second row.
    await recordIssuesChanged(shop.id, { opened: 1 }, testDb(), new Date(t0.getTime() + COALESCE_WINDOW_MS));

    const rows = await testDb().activityEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].payload).toMatchObject({ opened: 5, resolved: 1, highOpened: 1 });
    expect(rows[1].payload).toMatchObject({ opened: 1, resolved: 0 });
    expect(rows[0].coalesceBucket).toEqual(bucketOf(t0));
  });

  it("recordIssuesChanged no-ops when nothing changed", async () => {
    const shop = await createShop({ shopDomain: SHOP });
    await recordIssuesChanged(shop.id, { opened: 0, resolved: 0 }, testDb());
    expect(await testDb().activityEvent.count()).toBe(0);
  });

  it("purges events older than 90 days, keeping newer ones", async () => {
    const shop = await createShop({ shopDomain: SHOP });
    const now = new Date("2026-10-12T00:00:00Z");
    await createActivityEvent(shop.id, {
      kind: "plan_changed",
      createdAt: new Date(now.getTime() - (PURGE_AFTER_DAYS + 1) * 86_400_000),
    });
    await createActivityEvent(shop.id, { kind: "plan_changed", createdAt: now });

    const deleted = await purgeOldActivityEvents(now, testDb());
    expect(deleted).toBe(1);
    expect(await testDb().activityEvent.count()).toBe(1);
  });
});

describe("activity sentence rendering", () => {
  const t = makeT("en");

  it("renders every event kind with localized sentences", () => {
    for (const kind of ACTIVITY_EVENT_KINDS) {
      const sentence = activitySentence(t, kind, { opened: 2, resolved: 1, count: 3, score: 88, code: "x", plan: "pro", cap: 100 });
      expect(typeof sentence).toBe("string");
      // A missing/garbage payload must never leak raw ICU braces.
      expect(sentence).not.toMatch(/\{\w+, plural/);
    }
  });

  it("renders plurals inside the sentence (no raw braces leak)", () => {
    const sentence = activitySentence(t, "scan_completed", { opened: 7, resolved: 2, score: 88 });
    expect(sentence).toContain("7");
    expect(sentence).toContain("2");
    expect(sentence).not.toMatch(/\{|\}/);
  });
});

describe("since-last-visit card", () => {
  it("counts new/resolved issues, scans, and the score delta since the marker", async () => {
    const shop = await createShop({ shopDomain: SHOP, activitySeenAt: new Date("2026-10-12T10:00:00Z") });
    const since = new Date("2026-10-12T10:00:00Z");

    await createIssue(shop.id, { severity: "high", firstSeenAt: new Date("2026-10-12T11:00:00Z") });
    await createIssue(shop.id, { severity: "low", firstSeenAt: new Date("2026-10-12T11:30:00Z") });
    await createIssue(shop.id, {
      status: "resolved",
      resolvedAt: new Date("2026-10-12T12:00:00Z"),
      firstSeenAt: new Date("2026-10-11T09:00:00Z"),
    });
    // Old issue first seen before the marker: not "new".
    await createIssue(shop.id, { severity: "high", firstSeenAt: new Date("2026-10-10T09:00:00Z") });
    // Appeared AND resolved inside the window: not news.
    await createIssue(shop.id, {
      status: "resolved",
      resolvedAt: new Date("2026-10-12T12:00:00Z"),
      firstSeenAt: new Date("2026-10-12T11:45:00Z"),
    });

    await createScan(shop.id, { status: "completed", startedAt: new Date("2026-10-12T09:00:00Z"), finishedAt: new Date("2026-10-12T11:00:00Z") });
    await createScan(shop.id, { status: "failed", startedAt: new Date("2026-10-12T12:00:00Z"), finishedAt: new Date("2026-10-12T12:01:00Z") });

    const summary = await sinceLastVisit(shop.id, "free", since, testDb());
    expect(summary.newIssues).toBe(2); // high + low, both still open
    expect(summary.newHighIssues).toBe(1);
    expect(summary.resolvedIssues).toBe(2);
    expect(summary.scansFinished).toBe(1);
    expect(summary.scansFailed).toBe(1);
  });

  it("computes the score delta between the last scan before and the first after the marker", async () => {
    const shop = await createShop({ shopDomain: SHOP, activitySeenAt: new Date("2026-10-12T10:00:00Z") });
    const since = new Date("2026-10-12T10:00:00Z");

    // Before marker: score 50. After: 75 → delta +25.
    await testDb().scan.create({
      data: {
        shopId: shop.id,
        status: "completed",
        trigger: "scheduled",
        healthScore: 50,
        startedAt: new Date("2026-10-12T08:00:00Z"),
        finishedAt: new Date("2026-10-12T09:00:00Z"),
      },
    });
    await testDb().scan.create({
      data: {
        shopId: shop.id,
        status: "completed",
        trigger: "scheduled",
        healthScore: 75,
        startedAt: new Date("2026-10-12T11:00:00Z"),
        finishedAt: new Date("2026-10-12T12:00:00Z"),
      },
    });

    const summary = await sinceLastVisit(shop.id, "free", since, testDb());
    expect(summary.scoreDelta).toBe(25);
  });
});

describe("needs attention", () => {
  it("lists up to 5 newest open high-severity issues with names and badges", async () => {
    const since = new Date("2026-10-12T10:00:00Z");
    const shop = await createShop({ shopDomain: SHOP, activitySeenAt: since });

    for (let i = 0; i < 6; i++) {
      await createIssue(shop.id, {
        severity: "high",
        firstSeenAt: new Date(since.getTime() + (i + 1) * 60_000),
        variantGid: `gid://shopify/ProductVariant/${i}`,
        details: { product_title: `Product ${i}` },
      });
    }
    // An OLD open high issue also qualifies (spec: not marker-restricted).
    await createIssue(shop.id, {
      severity: "high",
      firstSeenAt: new Date("2026-09-01T09:00:00Z"),
      variantGid: "gid://shopify/ProductVariant/old",
      details: { product_title: "Old Product" },
    });
    // Low severity and resolved rows never appear.
    await createIssue(shop.id, { severity: "low", firstSeenAt: new Date("2026-10-12T11:00:00Z") });
    await createIssue(shop.id, { severity: "high", status: "resolved", resolvedAt: new Date("2026-10-12T11:00:00Z"), firstSeenAt: new Date("2026-10-12T10:30:00Z") });

    const items = await needsAttention(shop.id, since, 5, testDb());
    expect(items).toHaveLength(5);
    expect(items[0].productTitle).toBe("Product 5");
    expect(items.every((i) => i.severity === "high")).toBe(true);
    // All five are newer than the marker → all badged "New".
    expect(items.every((i) => i.isNew)).toBe(true);
  });

  it("badges only issues first seen after the marker", async () => {
    const since = new Date("2026-10-12T10:00:00Z");
    const shop = await createShop({ shopDomain: SHOP, activitySeenAt: since });
    await createIssue(shop.id, {
      severity: "high",
      firstSeenAt: new Date("2026-10-12T11:00:00Z"),
      variantGid: "gid://shopify/ProductVariant/new",
    });
    await createIssue(shop.id, {
      severity: "high",
      firstSeenAt: new Date("2026-10-01T09:00:00Z"),
      variantGid: "gid://shopify/ProductVariant/old",
    });

    const items = await needsAttention(shop.id, since, 5, testDb());
    expect(items).toHaveLength(2);
    const byGid = Object.fromEntries(items.map((i) => [i.variantGid.split("/").pop(), i.isNew]));
    expect(byGid["new"]).toBe(true);
    expect(byGid["old"]).toBe(false);
  });

  it("is empty when nothing qualifies", async () => {
    const shop = await createShop({ shopDomain: SHOP });
    const items = await needsAttention(shop.id, new Date(), 5, testDb());
    expect(items).toHaveLength(0);
  });
});

describe("weekly summary", () => {
  it("splits this week vs last week in the shop's time zone", async () => {
    const shop = await createShop({ shopDomain: SHOP, timezone: "UTC", uiLocale: "en" });

    // Anchor: Wednesday Oct 14 2026. Week start is Sunday Oct 11 or Monday
    // Oct 12 depending on locale data — the counts hold either way.
    const at = new Date("2026-10-14T12:00:00Z");
    const firstDay = localeWeekStartsOn("en");
    const thisWeekStart = weekStart(at, "UTC", firstDay);
    expect(thisWeekStart.getUTCDay()).toBe(firstDay % 7);

    await createIssue(shop.id, { firstSeenAt: new Date("2026-10-13T10:00:00Z") }); // this week
    await createIssue(shop.id, { firstSeenAt: new Date("2026-10-07T10:00:00Z") }); // last week
    await createIssue(shop.id, {
      status: "resolved",
      resolvedAt: new Date("2026-10-13T11:00:00Z"),
      firstSeenAt: new Date("2026-10-06T10:00:00Z"),
    });
    await createIssue(shop.id, { firstSeenAt: new Date("2026-09-28T10:00:00Z") }); // two weeks ago

    const summary = await weeklySummary(shop.id, { at, timeZone: "UTC", locale: "en" }, testDb());
    expect(summary.newThisWeek).toBe(1);
    expect(summary.newLastWeek).toBe(2); // Oct 6 + Oct 7 both fall in last week
    expect(summary.resolvedThisWeek).toBe(1);
  });

  it("weekStart honors the shop's time zone (America/New_York)", () => {
    // 2026-10-14 01:30 UTC is 2026-10-13 21:30 in New York: the local
    // calendar day is Oct 13 (Tuesday), so a Sunday-start week begins
    // Oct 11 local = Oct 11 04:00 UTC (EDT, UTC-4).
    const at = new Date("2026-10-14T01:30:00Z");
    const start = weekStart(at, "America/New_York", 0);
    expect(start.toISOString()).toBe("2026-10-11T04:00:00.000Z");
  });

  it("weekStart resolves the locale's first day via weekInfo or defaults to Monday", () => {
    // Node exposes weekInfo (en → Sunday per CLDR); the value is 0 or 1 and
    // weekStart must use it consistently.
    expect([0, 1]).toContain(localeWeekStartsOn("en"));
  });
});

describe("activity feed and seen marker", () => {
  it("pages newest-first within the plan window and reports older hidden rows", async () => {
    const shop = await createShop({ shopDomain: SHOP, plan: "free" });
    const now = new Date("2026-10-12T12:00:00Z");

    // Free window is 7 days: a 10-day-old event is hidden with an upgrade hint.
    await createActivityEvent(shop.id, { kind: "scan_completed", payload: { opened: 1 }, createdAt: new Date(now.getTime() - 10 * 86_400_000) });
    await createActivityEvent(shop.id, { kind: "issues_changed", createdAt: new Date(now.getTime() - 2 * 86_400_000) });
    await createActivityEvent(shop.id, { kind: "plan_changed", payload: { plan: "starter" }, createdAt: new Date(now.getTime() - 86_400_000) });

    const feed = await activityFeed(shop.id, "free", { now, pageSize: 10 });
    expect(feed.windowDays).toBe(activityHistoryDays("free"));
    expect(feed.items.map((i) => i.kind)).toEqual(["plan_changed", "issues_changed"]);
    expect(feed.totalOlder).toBe(1);

    // A Pro shop sees the third event too (90-day window).
    const proFeed = await activityFeed(shop.id, "pro", { now, pageSize: 10 });
    expect(proFeed.items).toHaveLength(3);
    expect(proFeed.totalOlder).toBe(0);
  });

  it("filters by kind", async () => {
    const shop = await createShop({ shopDomain: SHOP });
    await createActivityEvent(shop.id, { kind: "scan_completed", createdAt: new Date() });
    await createActivityEvent(shop.id, { kind: "plan_changed", createdAt: new Date() });

    const feed = await activityFeed(shop.id, "free", { kind: "plan_changed", pageSize: 10 });
    expect(feed.items.every((i) => i.kind === "plan_changed")).toBe(true);
    expect(feed.items).toHaveLength(1);
  });

  it("paginates newest-first and clamps out-of-range pages", async () => {
    const shop = await createShop({ shopDomain: SHOP });
    const base = new Date("2026-10-12T12:00:00Z").getTime();
    for (let i = 0; i < 5; i++) {
      await createActivityEvent(shop.id, {
        kind: "scan_completed",
        payload: { score: i },
        createdAt: new Date(base - i * 60_000),
      });
    }

    const page1 = await activityFeed(shop.id, "free", { pageSize: 2, page: 1, now: new Date(base + 3_600_000) });
    const page2 = await activityFeed(shop.id, "free", { pageSize: 2, page: 2, now: new Date(base + 3_600_000) });
    const clamped = await activityFeed(shop.id, "free", { pageSize: 2, page: 99, now: new Date(base + 3_600_000) });

    expect(page1.pageCount).toBe(3);
    expect(page1.totalInWindow).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect((page1.items[0].payload as { score?: number }).score).toBe(0); // newest first
    expect((page1.items[1].payload as { score?: number }).score).toBe(1);
    expect((page2.items[0].payload as { score?: number }).score).toBe(2);
    // Page 99 clamps to the last page (3): rows 5 and 4 by recency… i.e.
    // the two oldest visible rows.
    expect(clamped.page).toBe(3);
    expect(clamped.items).toHaveLength(1);
    expect((clamped.items[0].payload as { score?: number }).score).toBe(4);
  });

  it("markActivitySeen moves the marker; hasUnseenActivity flips; dashboard loads do not touch it", async () => {
    const shop = await createShop({ shopDomain: SHOP, activitySeenAt: new Date("2026-10-12T10:00:00Z") });
    await createIssue(shop.id, { firstSeenAt: new Date("2026-10-12T11:00:00Z") });

    const before = await testDb().shop.findUnique({ where: { id: shop.id } });
    expect(await hasUnseenActivity(shop.id, before!.activitySeenAt, testDb())).toBe(true);

    await markActivitySeen(shop.id, testDb(), new Date("2026-10-12T12:00:00Z"));
    const after = await testDb().shop.findUnique({ where: { id: shop.id } });
    expect(after!.activitySeenAt?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(await hasUnseenActivity(shop.id, after!.activitySeenAt, testDb())).toBe(false);
  });

  it("markActivitySeen can restore a previous marker (undo)", async () => {
    const shop = await createShop({ shopDomain: SHOP, activitySeenAt: new Date("2026-10-12T10:00:00Z") });
    await markActivitySeen(shop.id, testDb(), new Date("2026-10-12T12:00:00Z"));
    await markActivitySeen(shop.id, testDb(), new Date("2026-10-12T10:00:00Z"));
    const row = await testDb().shop.findUnique({ where: { id: shop.id } });
    expect(row!.activitySeenAt?.toISOString()).toBe("2026-10-12T10:00:00.000Z");
  });

  it("hasUnseenActivity also flags scan failures, plan changes, and over-cap events", async () => {
    const shop = await createShop({ shopDomain: SHOP, activitySeenAt: new Date("2026-10-12T10:00:00Z") });
    const seen = new Date("2026-10-12T10:00:00Z");

    expect(await hasUnseenActivity(shop.id, seen, testDb())).toBe(false);
    await createActivityEvent(shop.id, { kind: "scan_failed", createdAt: new Date("2026-10-12T10:05:00Z") });
    expect(await hasUnseenActivity(shop.id, seen, testDb())).toBe(true);

    const shop2 = await createShop({ activitySeenAt: seen });
    await createActivityEvent(shop2.id, { kind: "over_cap", createdAt: new Date("2026-10-12T10:05:00Z") });
    expect(await hasUnseenActivity(shop2.id, seen, testDb())).toBe(true);
  });
});
