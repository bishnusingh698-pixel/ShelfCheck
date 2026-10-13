/**
 * Route-level integration tests for spec <in_app_alerts>: the dashboard's
 * since-last-visit / needs-attention / weekly cards, the "New" badge and
 * "New only" filter on the issues list, the Activity page (window, kind
 * filter, mark-seen semantics, undo), and the layout nav badge.
 *
 * Runs the REAL route loaders/actions against the test database through the
 * UI harness seam (every admin request resolves to the fixture shop).
 * Environment must be set before any app module import, so every app import
 * here is dynamic.
 */

process.env.UI_HARNESS = "1";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://openhands:openhands@127.0.0.1:5432/shelfcheck_test?connection_limit=5";

import "../helpers/shopify-test-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, disposeTestDb, testDb } from "../helpers/db.js";

type IndexRoute = typeof import("../../app/routes/app._index.js");
type IssuesRoute = typeof import("../../app/routes/app.issues.js");
type ActivityRoute = typeof import("../../app/routes/app.activity.js");
type LayoutRoute = typeof import("../../app/routes/app.js");
type Events = typeof import("../../app/activity/events.server.js");

let indexLoader: IndexRoute["loader"];
let issuesLoader: IssuesRoute["loader"];
let activityLoader: ActivityRoute["loader"];
let activityAction: ActivityRoute["action"];
let layoutLoader: LayoutRoute["loader"];
let recordActivityEvent: Events["recordActivityEvent"];

/** The harness shop every admin loader resolves to. */
const SHOP_ID = "ui-harness-shop";
const MARKER = new Date("2026-10-12T10:00:00Z");

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.example.com${path}`, init);
}

function routeArgs(req: Request, params: Record<string, string> = {}) {
  return {
    request: req,
    params,
    context: {},
    url: new URL(req.url),
    pattern: { path: req.url, basename: "/" },
  } as never;
}

function formPost(path: string, fields: Record<string, string | string[]>): Request {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else params.set(k, v);
  }
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

beforeAll(async () => {
  indexLoader = (await import("../../app/routes/app._index.js")).loader;
  issuesLoader = (await import("../../app/routes/app.issues.js")).loader;
  activityLoader = (await import("../../app/routes/app.activity.js")).loader;
  activityAction = (await import("../../app/routes/app.activity.js")).action;
  layoutLoader = (await import("../../app/routes/app.js")).loader;
  recordActivityEvent = (await import("../../app/activity/events.server.js")).recordActivityEvent;
});

beforeEach(async () => {
  await resetDb();
  // The harness seam binds admin requests to the fixture shop; reset its
  // activity state per test and own all issue/scan/event rows.
  await (await import("../../app/lib/ui-harness.server.js")).seedUiHarnessFixture(testDb());
  const db = testDb();
  await db.shop.update({
    where: { id: SHOP_ID },
    data: { activitySeenAt: MARKER, plan: "starter", lastScanAt: null },
  });
  await db.issue.deleteMany({});
  await db.scan.deleteMany({});
  await db.activityEvent.deleteMany({});
});

afterAll(async () => {
  await disposeTestDb();
});

async function createIssueRow(overrides: Record<string, unknown> = {}) {
  await testDb().issue.create({
    data: {
      shopId: SHOP_ID,
      type: "MISSING_SKU",
      severity: "high",
      variantGid: `gid://shopify/ProductVariant/${Math.floor(Math.random() * 1e9)}`,
      groupKey: "",
      details: {},
      status: "open",
      firstSeenAt: new Date("2026-10-10T09:00:00Z"),
      ...overrides,
    } as never,
  });
}

describe("dashboard loader (app._index) — in-app activity cards", () => {
  it("returns the since-last-visit summary, needs-attention list, and weekly card", async () => {
    // New open issues after the marker (one high), one resolved, one scan.
    await createIssueRow({
      type: "MISSING_SKU",
      severity: "high",
      variantGid: "gid://shopify/ProductVariant/na-1",
      details: { product_title: "Attention Widget" },
      firstSeenAt: new Date("2026-10-12T11:00:00Z"),
    });
    await createIssueRow({
      type: "MISSING_BARCODE",
      severity: "low",
      variantGid: "gid://shopify/ProductVariant/na-2",
      firstSeenAt: new Date("2026-10-12T11:30:00Z"),
    });
    await createIssueRow({
      type: "MISSING_WEIGHT",
      severity: "medium",
      variantGid: "gid://shopify/ProductVariant/na-3",
      status: "resolved",
      resolvedAt: new Date("2026-10-12T12:00:00Z"),
    });
    await testDb().scan.create({
      data: {
        shopId: SHOP_ID,
        status: "completed",
        trigger: "manual",
        healthScore: 80,
        startedAt: new Date("2026-10-12T09:30:00Z"),
        finishedAt: new Date("2026-10-12T11:00:00Z"),
        createdAt: new Date("2026-10-12T11:00:00Z"),
      } as never,
    });

    const data = await indexLoader(routeArgs(request("/app")));
    expect(data.sinceVisit.newIssues).toBe(2);
    expect(data.sinceVisit.newHighIssues).toBe(1);
    expect(data.sinceVisit.resolvedIssues).toBe(1);
    expect(data.sinceVisit.scansFinished).toBe(1);

    expect(data.attention).toHaveLength(1);
    expect(data.attention[0].productTitle).toBe("Attention Widget");
    expect(data.attention[0].severity).toBe("high");

    expect(data.weekly).not.toBeNull();
  });

  it("free plan: weekly summary is null (LockedFeature shown client-side)", async () => {
    await testDb().shop.update({ where: { id: SHOP_ID }, data: { plan: "free" } });
    const data = await indexLoader(routeArgs(request("/app")));
    expect(data.weekly).toBeNull();
  });

  it("loading the dashboard does NOT move the seen marker", async () => {
    await indexLoader(routeArgs(request("/app")));
    await indexLoader(routeArgs(request("/app")));
    const row = await testDb().shop.findUnique({ where: { id: SHOP_ID } });
    expect(row?.activitySeenAt?.toISOString()).toBe(MARKER.toISOString());
  });
});

describe("issues list (app.issues) — New badge and New only filter", () => {
  async function seedIssueList() {
    await createIssueRow({
      variantGid: "gid://shopify/ProductVariant/new-1",
      details: { product_title: "New Issue" },
      firstSeenAt: new Date("2026-10-12T11:00:00Z"), // after marker → New
    });
    await createIssueRow({
      variantGid: "gid://shopify/ProductVariant/old-1",
      details: { product_title: "Old Issue" },
      firstSeenAt: new Date("2026-10-10T09:00:00Z"), // before marker → not New
    });
    await createIssueRow({
      type: "MISSING_BARCODE",
      severity: "medium",
      variantGid: "gid://shopify/ProductVariant/new-2",
      details: { product_title: "New But Resolved" },
      status: "resolved",
      resolvedAt: new Date("2026-10-12T12:00:00Z"),
      firstSeenAt: new Date("2026-10-12T11:10:00Z"), // after marker but resolved
    });
  }

  it("flags exactly the open issues first seen after the marker", async () => {
    await seedIssueList();
    const data = await issuesLoader(routeArgs(request("/app/issues")));

    const byTitle = Object.fromEntries(data.list.rows.map((r) => [r.productTitle, r]));
    expect(byTitle["New Issue"].isNew).toBe(true);
    expect(byTitle["Old Issue"].isNew).toBe(false);
  });

  it("New only returns just those rows", async () => {
    await seedIssueList();
    const data = await issuesLoader(routeArgs(request("/app/issues?newOnly=1")));

    expect(data.list.rows).toHaveLength(1);
    expect(data.list.rows[0].productTitle).toBe("New Issue");
    expect(data.filters.newOnly).toBe(true);
  });

  it("newOnly with no marker (fresh install) shows every open issue as New", async () => {
    await testDb().shop.update({ where: { id: SHOP_ID }, data: { activitySeenAt: null } });
    await seedIssueList();
    const data = await issuesLoader(routeArgs(request("/app/issues?newOnly=1")));
    // Marker null → everything is "new" (firstSeenAt > epoch).
    expect(data.list.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("invalid newOnly values drop to false, not coerce garbage to true", async () => {
    await seedIssueList();
    const data = await issuesLoader(routeArgs(request("/app/issues?newOnly=banana")));
    expect(data.filters.newOnly).toBe(false);
    expect(data.list.rows.length).toBe(2); // default status=open filter
  });
});

describe("activity page (app.activity)", () => {
  it("loader returns the windowed feed and moves the marker on open", async () => {
    const db = testDb();
    await recordActivityEvent({
      shopId: SHOP_ID,
      kind: "scan_failed",
      payload: { code: "bulk_timeout" },
      now: new Date("2026-10-12T11:00:00Z"),
      client: db,
    });
    // Out of the 30-day starter window (10 days old is INSIDE it, so use 40):
    await recordActivityEvent({
      shopId: SHOP_ID,
      kind: "plan_changed",
      payload: { plan: "starter" },
      now: new Date(Date.now() - 40 * 86_400_000),
      client: db,
    });

    const data = await activityLoader(routeArgs(request("/app/activity")));
    expect(data.items).toHaveLength(1);
    expect(data.items[0].kind).toBe("scan_failed");
    expect(data.windowDays).toBe(30); // harness shop plan is starter
    expect(data.totalOlder).toBe(1);
    expect(data.kinds).toContain("issues_changed");

    // Opening the page marks activity seen (spec <in_app_alerts>).
    const row = await db.shop.findUnique({ where: { id: SHOP_ID } });
    expect(row?.activitySeenAt).toBeTruthy();
    expect(row!.activitySeenAt!.getTime()).toBeGreaterThan(MARKER.getTime());
  });

  it("kind filter narrows the feed", async () => {
    const db = testDb();
    await recordActivityEvent({ shopId: SHOP_ID, kind: "scan_failed", payload: { code: "x" }, client: db, now: new Date() });
    await recordActivityEvent({ shopId: SHOP_ID, kind: "plan_changed", payload: { plan: "pro" }, client: db, now: new Date() });

    const data = await activityLoader(routeArgs(request("/app/activity?kind=plan_changed")));
    expect(data.items).toHaveLength(1);
    expect(data.items[0].kind).toBe("plan_changed");
  });

  it("invalid kind falls back to the unfiltered feed", async () => {
    const db = testDb();
    await recordActivityEvent({ shopId: SHOP_ID, kind: "scan_failed", payload: { code: "x" }, client: db, now: new Date() });
    await recordActivityEvent({ shopId: SHOP_ID, kind: "plan_changed", payload: { plan: "pro" }, client: db, now: new Date() });

    const data = await activityLoader(routeArgs(request("/app/activity?kind=nonsense")));
    expect(data.items).toHaveLength(2);
    expect(data.kind).toBeNull();
  });

  it("mark-seen action moves the marker to now and redirects with the undo param", async () => {
    const res = await activityAction(
      routeArgs(formPost("/app/activity", { intent: "activity_seen", redirectTo: "/app" })),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("/app?undo=")).toBe(true);

    const row = await testDb().shop.findUnique({ where: { id: SHOP_ID } });
    expect(row?.activitySeenAt?.getTime()).toBeGreaterThan(MARKER.getTime());

    // The undo param captured the OLD marker so Undo can restore it.
    const undo = new URLSearchParams(location.split("?")[1]).get("undo");
    expect(undo).toBe(MARKER.toISOString());
  });

  it("undo action restores the previous marker and clears the banner", async () => {
    await activityAction(routeArgs(formPost("/app/activity", { intent: "activity_seen" })));
    const res = await activityAction(
      routeArgs(
        formPost("/app/activity", {
          intent: "activity_seen_undo",
          previousSeenAt: MARKER.toISOString(),
          redirectTo: "/app",
        }),
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app");

    const row = await testDb().shop.findUnique({ where: { id: SHOP_ID } });
    expect(row?.activitySeenAt?.toISOString()).toBe(MARKER.toISOString());
  });

  it("undo with a future timestamp is rejected (cannot time-travel forward)", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await activityAction(
      routeArgs(
        formPost("/app/activity", {
          intent: "activity_seen_undo",
          previousSeenAt: future,
        }),
      ),
    );
    const row = await testDb().shop.findUnique({ where: { id: SHOP_ID } });
    expect(row?.activitySeenAt?.toISOString()).toBe(MARKER.toISOString());
  });

  it("unknown intent redirects without side effects", async () => {
    const res = await activityAction(routeArgs(formPost("/app/activity", { intent: "bogus" })));
    expect(res.status).toBe(302);
    const row = await testDb().shop.findUnique({ where: { id: SHOP_ID } });
    expect(row?.activitySeenAt?.toISOString()).toBe(MARKER.toISOString());
  });
});

describe("issue detail panel (app.issues.$issueId) — New badge", () => {
  it("badges an open issue first seen after the marker", async () => {
    await createIssueRow({
      variantGid: "gid://shopify/ProductVariant/detail-new",
      firstSeenAt: new Date("2026-10-12T11:00:00Z"),
    });
    const rows = await testDb().issue.findMany({
      where: { variantGid: "gid://shopify/ProductVariant/detail-new" },
    });
    const loader = (await import("../../app/routes/app.issues.$issueId.js")).loader;
    const data = await loader(routeArgs(request("/app/issues/x"), { issueId: rows[0].id }));
    expect(data.notFound).toBe(false);
    if (data.notFound) throw new Error("issue missing");
    expect(data.issue.isNew).toBe(true);
  });

  it("does not badge an old issue, a resolved one, or when no marker exists", async () => {
    await createIssueRow({
      variantGid: "gid://shopify/ProductVariant/detail-old",
      firstSeenAt: new Date("2026-10-10T09:00:00Z"),
    });
    await createIssueRow({
      variantGid: "gid://shopify/ProductVariant/detail-resolved",
      status: "resolved",
      resolvedAt: new Date("2026-10-12T12:00:00Z"),
      firstSeenAt: new Date("2026-10-12T11:00:00Z"),
    });

    const loader = (await import("../../app/routes/app.issues.$issueId.js")).loader;
    const oldRow = await testDb().issue.findFirst({ where: { variantGid: "gid://shopify/ProductVariant/detail-old" } });
    const resolvedRow = await testDb().issue.findFirst({ where: { variantGid: "gid://shopify/ProductVariant/detail-resolved" } });

    const oldData = await loader(routeArgs(request("/app/issues/x"), { issueId: oldRow!.id }));
    const resolvedData = await loader(routeArgs(request("/app/issues/x"), { issueId: resolvedRow!.id }));
    if (oldData.notFound || resolvedData.notFound) throw new Error("issue missing");
    expect(oldData.issue.isNew).toBe(false);
    expect(resolvedData.issue.isNew).toBe(false);

    // Fresh install: no marker → nothing is "new" (all issues are the
    // baseline the merchant sees on first open).
    await testDb().shop.update({ where: { id: SHOP_ID }, data: { activitySeenAt: null } });
    await createIssueRow({
      variantGid: "gid://shopify/ProductVariant/detail-nomarker",
      firstSeenAt: new Date("2026-10-12T11:00:00Z"),
    });
    const noMarkerRow = await testDb().issue.findFirst({ where: { variantGid: "gid://shopify/ProductVariant/detail-nomarker" } });
    const noMarkerData = await loader(routeArgs(request("/app/issues/x"), { issueId: noMarkerRow!.id }));
    if (noMarkerData.notFound) throw new Error("issue missing");
    expect(noMarkerData.issue.isNew).toBe(false);
  });
});

describe("layout nav badge (app.tsx)", () => {
  it("sets unseenActivity when an open issue is newer than the marker", async () => {
    await createIssueRow({
      variantGid: "gid://shopify/ProductVariant/nav-1",
      firstSeenAt: new Date("2026-10-12T11:00:00Z"),
    });

    const data = await layoutLoader(routeArgs(request("/app")));
    expect(data.unseenActivity).toBe(true);
  });

  it("is false when everything is old news", async () => {
    const data = await layoutLoader(routeArgs(request("/app")));
    expect(data.unseenActivity).toBe(false);
  });

  it("flags scan failures even with no new issues", async () => {
    await recordActivityEvent({
      shopId: SHOP_ID,
      kind: "scan_failed",
      payload: { code: "graph_error" },
      now: new Date("2026-10-12T11:00:00Z"),
      client: testDb(),
    });
    const data = await layoutLoader(routeArgs(request("/app")));
    expect(data.unseenActivity).toBe(true);
  });
});
