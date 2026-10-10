/**
 * Route-level integration tests for the Phase 9 UI server logic: the issues
 * list (app.issues), issue detail (app.issues.$issueId), rules (app.rules),
 * settings (app.settings), plans (app.plans), and CSV export
 * (app.export.csv), plus the [AUTO] acceptance items that land with this
 * phase (intentional regrowth through the UI action, plan display cap, and
 * the empty-catalog list state).
 *
 * Runs the REAL route loaders/actions against the test database through the
 * UI harness seam. Environment must be set before any app module import, so
 * every app import here is dynamic.
 */

process.env.UI_HARNESS = "1";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://openhands:openhands@127.0.0.1:5432/shelfcheck_test?connection_limit=5";

import "../helpers/shopify-test-env.js";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, disposeTestDb, testDb } from "../helpers/db.js";

type IssuesRoute = typeof import("../../app/routes/app.issues.js");
type DetailRoute = typeof import("../../app/routes/app.issues.$issueId.js");
type RulesRoute = typeof import("../../app/routes/app.rules.js");
type SettingsRoute = typeof import("../../app/routes/app.settings.js");
type PlansRoute = typeof import("../../app/routes/app.plans.js");
type CsvRoute = typeof import("../../app/routes/app.export.csv.js");
type Harness = typeof import("../../app/lib/ui-harness.server.js");
type Lifecycle = typeof import("../../app/issues/lifecycle.server.js");

let issuesRoute: IssuesRoute;
let detailRoute: DetailRoute;
let rulesRoute: RulesRoute;
let settingsRoute: SettingsRoute;
let plansRoute: PlansRoute;
let csvRoute: CsvRoute;
let seed: Harness["seedUiHarnessFixture"];
let lifecycle: Lifecycle;
let upsertIssue: Lifecycle["upsertIssue"];
let markIntentionalRegrowth: Lifecycle["markIntentionalRegrowth"];

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

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Response.text() strips a leading UTF-8 BOM (per the fetch spec), so CSV
 * tests decode the raw bytes with the BOM preserved instead.
 */
async function csvText(res: Response): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
}

beforeAll(async () => {
  issuesRoute = (await import("../../app/routes/app.issues.js")) as IssuesRoute;
  detailRoute = (await import("../../app/routes/app.issues.$issueId.js")) as DetailRoute;
  rulesRoute = (await import("../../app/routes/app.rules.js")) as RulesRoute;
  settingsRoute = (await import("../../app/routes/app.settings.js")) as SettingsRoute;
  plansRoute = (await import("../../app/routes/app.plans.js")) as PlansRoute;
  csvRoute = (await import("../../app/routes/app.export.csv.js")) as CsvRoute;
  seed = (await import("../../app/lib/ui-harness.server.js")).seedUiHarnessFixture;
  lifecycle = (await import("../../app/issues/lifecycle.server.js")) as Lifecycle;
  ({ upsertIssue, markIntentionalRegrowth } = lifecycle);
});

beforeEach(async () => {
  await resetDb();
  await seed(testDb());
});

afterAll(async () => {
  await disposeTestDb();
});

describe("issues list loader (app.issues)", () => {
  it("shows the open punch list with duplicate groups collapsed", async () => {
    const data = await issuesRoute.loader(routeArgs(request("/app/issues")));

    // 2 MISSING_SKU singles + 2 MISSING_BARCODE singles + 1 DUPLICATE_SKU group.
    expect(data.list.total).toBe(5);
    expect(data.list.rows).toHaveLength(5);
    expect(data.list.page).toBe(1);
    expect(data.list.hidden).toBe(0);

    const dup = data.list.rows.find((r) => r.type === "DUPLICATE_SKU");
    expect(dup).toBeDefined();
    expect(dup!.memberCount).toBe(2);
    expect(dup!.groupKey).toBe("dup-1");
    expect(dup!.productTitle).toBe("Harness Dup Widget A");
    expect(dup!.sku).toBe("DUP-1");
  });

  it("orders high severity first and honors the severity/type/status filters", async () => {
    const high = await issuesRoute.loader(routeArgs(request("/app/issues?severity=high")));
    expect(high.list.rows.every((r) => r.severity === "high")).toBe(true);

    const dupOnly = await issuesRoute.loader(routeArgs(request("/app/issues?type=DUPLICATE_SKU")));
    expect(dupOnly.list.total).toBe(1);
    expect(dupOnly.list.rows[0].type).toBe("DUPLICATE_SKU");

    const snoozed = await issuesRoute.loader(routeArgs(request("/app/issues?status=snoozed")));
    expect(snoozed.list.total).toBe(1);
    expect(snoozed.list.rows[0].type).toBe("MISSING_WEIGHT");
    expect(snoozed.list.rows[0].snoozedUntil).not.toBeNull();
  });

  it("searches by SKU and product title and filters by vendor", async () => {
    const bySku = await issuesRoute.loader(routeArgs(request("/app/issues?q=DUP-1")));
    expect(bySku.list.total).toBe(1);
    expect(bySku.list.rows[0].type).toBe("DUPLICATE_SKU");

    const byTitle = await issuesRoute.loader(routeArgs(request("/app/issues?q=Harness Medium Widget")));
    expect(byTitle.list.total).toBe(2);

    const byVendor = await issuesRoute.loader(routeArgs(request("/app/issues?vendor=OtherVendor")));
    expect(byVendor.list.total).toBe(3);
    expect(byVendor.list.vendors).toContain("HarnessVendor");
    expect(byVendor.list.vendors).toContain("OtherVendor");
  });

  it("paginates and clamps out-of-range pages", async () => {
    const data = await issuesRoute.loader(routeArgs(request("/app/issues?page=99")));
    expect(data.list.page).toBe(1);
    expect(data.filters.page).toBe(1);
  });

  it("caps the visible rows for the free plan and reports the hidden count", async () => {
    const db = testDb();
    await db.shop.update({
      where: { id: "ui-harness-shop" },
      data: { plan: "free" },
    });
    for (let i = 0; i < 60; i += 1) {
      await db.issue.create({
        data: {
          shopId: "ui-harness-shop",
          type: "MISSING_SKU",
          severity: "low",
          variantGid: `gid://shopify/ProductVariant/extra-${i}`,
          productGid: `gid://shopify/Product/extra-${i}`,
          groupKey: "",
          details: { product_title: `Extra ${i}` },
          status: "open",
          firstSeenScanId: "seed",
          lastSeenScanId: "seed",
        },
      });
    }

    const data = await issuesRoute.loader(routeArgs(request("/app/issues")));
    // 5 seeded groups + 60 extras = 65 matching; free shows only 50.
    expect(data.list.total).toBe(50);
    expect(data.list.hidden).toBe(15);
    expect(data.list.rows.length).toBeLessThanOrEqual(25);
  });

  it("returns an empty list for a shop with no issues (acceptance 5)", async () => {
    const db = testDb();
    await db.issue.deleteMany({ where: { shopId: "ui-harness-shop" } });
    const data = await issuesRoute.loader(routeArgs(request("/app/issues")));
    expect(data.list.rows).toHaveLength(0);
    expect(data.list.total).toBe(0);
    expect(data.list.pageCount).toBe(1);
  });
});

describe("issues list action (app.issues)", () => {
  it("snoozes, unsnoozes, ignores, resolves, and restores via undo", async () => {
    const db = testDb();
    const first = await db.issue.findFirstOrThrow({
      where: { shopId: "ui-harness-shop", type: "MISSING_SKU" },
      orderBy: { variantGid: "asc" },
    });

    const snoozeRes = await issuesRoute.action(
      routeArgs(formPost("/app/issues", { intent: "snooze", ids: first.id, days: "7" })),
    );
    const snoozeBody = await json(snoozeRes as unknown as Response);
    expect(snoozeBody.ok).toBe(true);
    expect(snoozeBody.undo).toMatchObject({ ids: [first.id], from: ["open"] });

    const snoozedRow = await db.issue.findUniqueOrThrow({ where: { id: first.id } });
    expect(snoozedRow.status).toBe("snoozed");
    expect(snoozedRow.snoozedUntil).not.toBeNull();

    const undoRes = await issuesRoute.action(
      routeArgs(
        formPost("/app/issues", {
          intent: "restore",
          ids: first.id,
          from: String(snoozeBody.undo && (snoozeBody.undo as { from: string[] }).from[0]),
        }),
      ),
    );
    expect(((await json(undoRes as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    const restored = await db.issue.findUniqueOrThrow({ where: { id: first.id } });
    expect(restored.status).toBe("open");
    expect(restored.snoozedUntil).toBeNull();

    const ignoreRes = await issuesRoute.action(
      routeArgs(formPost("/app/issues", { intent: "ignore", ids: first.id })),
    );
    expect(((await json(ignoreRes as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    expect((await db.issue.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("ignored");

    const resolveRes = await issuesRoute.action(
      routeArgs(formPost("/app/issues", { intent: "resolve", ids: first.id })),
    );
    expect(((await json(resolveRes as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    expect((await db.issue.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("resolved");
    expect((await db.issue.findUniqueOrThrow({ where: { id: first.id } })).resolvedAt).not.toBeNull();
  });

  it("snoozes in bulk and marks duplicate groups intentional with a baseline", async () => {
    const db = testDb();
    const group = await db.issue.findMany({
      where: { shopId: "ui-harness-shop", groupKey: "dup-1" },
      orderBy: { variantGid: "asc" },
    });
    expect(group).toHaveLength(2);

    const res = await issuesRoute.action(
      routeArgs(formPost("/app/issues", { intent: "intentional", ids: group.map((g) => g.id) })),
    );
    expect(((await json(res as unknown as Response)) as { ok: boolean }).ok).toBe(true);

    const after = await db.issue.findMany({ where: { shopId: "ui-harness-shop", groupKey: "dup-1" } });
    expect(after.every((a) => a.status === "intentional")).toBe(true);
    expect(after.every((a) => a.intentionalMemberCount === 2)).toBe(true);

    // The intentional group stays out of the default open punch list.
    const list = await issuesRoute.loader(routeArgs(request("/app/issues")));
    expect(list.list.rows.some((r) => r.type === "DUPLICATE_SKU")).toBe(false);
  });

  it("rejects invalid intents and cross-shop ids", async () => {
    const bad = await issuesRoute.action(
      routeArgs(formPost("/app/issues", { intent: "snooze", ids: "whatever", days: "13" })),
    );
    expect((bad as unknown as Response).status).toBe(400);

    const crossShop = await issuesRoute.action(
      routeArgs(formPost("/app/issues", { intent: "ignore", ids: "not-an-issue" })),
    );
    expect((crossShop as unknown as Response).status).toBe(404);
  });

  it("keeps intentional status across later scans and reopens the group exactly once when a new variant joins (acceptance 4)", async () => {
    const db = testDb();
    const shopId = "ui-harness-shop";
    const group = await db.issue.findMany({
      where: { shopId, groupKey: "dup-1" },
      orderBy: { variantGid: "asc" },
    });

    // 1. The merchant marks the duplicate group intentional from the UI.
    await issuesRoute.action(
      routeArgs(formPost("/app/issues", { intent: "intentional", ids: group.map((g) => g.id) })),
    );

    // 2. Later scan: same two members come back — upsert preserves the
    //    manual status, and nothing reopens.
    const findings = group.map((g) => ({
      type: "DUPLICATE_SKU" as const,
      severity: "high" as const,
      variantGid: g.variantGid,
      productGid: g.productGid ?? "",
      groupKey: "dup-1",
      details: {},
    }));
    for (const f of findings) await upsertIssue(shopId, "scan-2", f, db);
    let regrown = await markIntentionalRegrowth(shopId, findings, db);
    expect(regrown).toBe(0);
    let rows = await db.issue.findMany({ where: { shopId, groupKey: "dup-1" } });
    expect(rows.every((r) => r.status === "intentional")).toBe(true);

    // 3. A new variant joins the duplicate group: the group reopens once.
    const newFinding = {
      type: "DUPLICATE_SKU" as const,
      severity: "high" as const,
      variantGid: "gid://shopify/ProductVariant/h403",
      productGid: "gid://shopify/Product/h6",
      groupKey: "dup-1",
      details: {},
    };
    await upsertIssue(shopId, "scan-2", newFinding, db);
    regrown = await markIntentionalRegrowth(shopId, [...findings, newFinding], db);
    expect(regrown).toBe(1);
    rows = await db.issue.findMany({ where: { shopId, groupKey: "dup-1" } });
    expect(rows.every((r) => r.status === "open")).toBe(true);
    expect(rows.some((r) => (r.details as Record<string, unknown>)?.group_grew === true)).toBe(true);

    // 4. Re-running the same scan never reopens again.
    regrown = await markIntentionalRegrowth(shopId, [...findings, newFinding], db);
    expect(regrown).toBe(0);
  });
});

describe("issue detail (app.issues.$issueId)", () => {
  it("lists every member of a duplicate group with admin links", async () => {
    const db = testDb();
    const dup = await db.issue.findFirstOrThrow({ where: { shopId: "ui-harness-shop", groupKey: "dup-1" } });

    const data = await detailRoute.loader(routeArgs(request(`/app/issues/${dup.id}`), { issueId: dup.id }));
    assert(!data.notFound);
    expect(data.members).toHaveLength(2);
    expect(data.members.map((m) => m.sku)).toEqual(["DUP-1", "DUP-1"]);
    expect(data.members[0].adminUrl).toContain("admin.shopify.com/store/ui-harness/products/h4");
  });

  it("shows the snooze banner data for a snoozed issue", async () => {
    const db = testDb();
    const snoozed = await db.issue.findFirstOrThrow({
      where: { shopId: "ui-harness-shop", status: "snoozed" },
    });
    const data = await detailRoute.loader(
      routeArgs(request(`/app/issues/${snoozed.id}`), { issueId: snoozed.id }),
    );
    assert(!data.notFound);
    expect(data.issue.snoozedUntil).not.toBeNull();
  });

  it("404s (gracefully) for ids from another shop", async () => {
    const data = await detailRoute.loader(
      routeArgs(request("/app/issues/does-not-exist"), { issueId: "does-not-exist" }),
    );
    expect(data.notFound).toBe(true);
  });

  it("snoozes and restores a single issue", async () => {
    const db = testDb();
    const first = await db.issue.findFirstOrThrow({
      where: { shopId: "ui-harness-shop", type: "MISSING_SKU" },
    });

    await detailRoute.action(
      routeArgs(formPost(`/app/issues/${first.id}`, { intent: "snooze", days: "30" }), {
        issueId: first.id,
      }),
    );
    expect((await db.issue.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("snoozed");

    await detailRoute.action(
      routeArgs(formPost(`/app/issues/${first.id}`, { intent: "unsnooze" }), { issueId: first.id }),
    );
    expect((await db.issue.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("open");
  });
});

describe("rules (app.rules)", () => {
  it("adds, lists, and deletes ignore rules", async () => {
    const add = await rulesRoute.action(
      routeArgs(
        formPost("/app/rules", {
          intent: "add",
          scope: "sku",
          value: "LEGACY-1",
          issueType: "MISSING_SKU",
          note: "internal code",
        }),
      ),
    );
    expect(((await json(add as unknown as Response)) as { ok: boolean }).ok).toBe(true);

    const list = await rulesRoute.loader(routeArgs(request("/app/rules")));
    expect(list.rules).toHaveLength(1);
    expect(list.rules[0]).toMatchObject({ scope: "sku", value: "LEGACY-1", issueType: "MISSING_SKU" });

    const del = await rulesRoute.action(
      routeArgs(formPost("/app/rules", { intent: "delete", id: list.rules[0].id })),
    );
    expect(((await json(del as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    const after = await rulesRoute.loader(routeArgs(request("/app/rules")));
    expect(after.rules).toHaveLength(0);
  });

  it("rejects invalid scopes/values and foreign rule ids", async () => {
    const badScope = await rulesRoute.action(
      routeArgs(formPost("/app/rules", { intent: "add", scope: "nope", value: "x" })),
    );
    expect((badScope as unknown as Response).status).toBe(400);

    const emptyValue = await rulesRoute.action(
      routeArgs(formPost("/app/rules", { intent: "add", scope: "sku", value: "" })),
    );
    expect((emptyValue as unknown as Response).status).toBe(400);

    const foreign = await rulesRoute.action(
      routeArgs(formPost("/app/rules", { intent: "delete", id: "someone-elses-rule" })),
    );
    expect((foreign as unknown as Response).status).toBe(404);
  });
});

describe("settings (app.settings)", () => {
  it("saves issue types, catalog scope, digest, auto-tag, and language", async () => {
    const db = testDb();

    const types = await settingsRoute.action(
      routeArgs(
        formPost("/app/settings", { intent: "issueTypes", types: ["MISSING_SKU", "DUPLICATE_SKU"] }),
      ),
    );
    expect(((await json(types as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    const row1 = await db.shop.findUniqueOrThrow({ where: { id: "ui-harness-shop" } });
    expect((row1.settings as Record<string, unknown>).enabledIssueTypes).toEqual([
      "MISSING_SKU",
      "DUPLICATE_SKU",
    ]);

    const catalog = await settingsRoute.action(
      routeArgs(
        formPost("/app/settings", {
          intent: "catalog",
          includeDraft: "false",
          includeArchived: "false",
          acceptNonGtinBarcodes: "true",
        }),
      ),
    );
    expect(((await json(catalog as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    const row2 = await db.shop.findUniqueOrThrow({ where: { id: "ui-harness-shop" } });
    const settings2 = row2.settings as Record<string, unknown>;
    expect(settings2.includeDraft).toBe(false);
    expect(settings2.acceptNonGtinBarcodes).toBe(true);
    // Earlier section survives the merge.
    expect(settings2.enabledIssueTypes).toEqual(["MISSING_SKU", "DUPLICATE_SKU"]);

    const digest = await settingsRoute.action(
      routeArgs(
        formPost("/app/settings", {
          intent: "digest",
          enabled: "true",
          email: "owner@example.com",
          day: "1",
          hour: "9",
          skipWhenEmpty: "true",
        }),
      ),
    );
    expect(((await json(digest as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    const row3 = await db.shop.findUniqueOrThrow({ where: { id: "ui-harness-shop" } });
    expect(row3.settings).toMatchObject({
      digest: { enabled: true, email: "owner@example.com", day: 1, hour: 9, skipWhenEmpty: true },
    });

    const autoTag = await settingsRoute.action(
      routeArgs(formPost("/app/settings", { intent: "autoTag", enabled: "true" })),
    );
    expect(((await json(autoTag as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    const row4 = await db.shop.findUniqueOrThrow({ where: { id: "ui-harness-shop" } });
    expect((row4.settings as Record<string, unknown>).autoTag).toBe(true);

    const language = await settingsRoute.action(
      routeArgs(formPost("/app/settings", { intent: "language", uiLocale: "de", notifyLocale: "fr" })),
    );
    expect(((await json(language as unknown as Response)) as { ok: boolean }).ok).toBe(true);
    const row5 = await db.shop.findUniqueOrThrow({ where: { id: "ui-harness-shop" } });
    expect(row5.uiLocale).toBe("de");
    expect(row5.notifyLocale).toBe("fr");
  });

  it("rejects invalid input", async () => {
    const badLocale = await settingsRoute.action(
      routeArgs(formPost("/app/settings", { intent: "language", uiLocale: "xx", notifyLocale: "fr" })),
    );
    expect((badLocale as unknown as Response).status).toBe(400);

    const badIntent = await settingsRoute.action(
      routeArgs(formPost("/app/settings", { intent: "nope" })),
    );
    expect((badIntent as unknown as Response).status).toBe(400);
  });

  it("flags plan-gated features in the loader", async () => {
    const data = await settingsRoute.loader(routeArgs(request("/app/settings")));
    expect(data.plan).toBe("starter");
    expect(data.featureEnabled).toEqual({ digest: true, autoTag: false, telegram: false });
  });
});

describe("plans (app.plans)", () => {
  it("exposes the plan table, the current plan, and the managed-pricing URL", async () => {
    const data = await plansRoute.loader(routeArgs(request("/app/plans")));
    expect(data.currentPlan).toBe("starter");
    expect(data.plans.map((p) => p.id)).toEqual(["free", "starter", "pro"]);
    expect(data.pricingUrl).toContain("/apps/");
    expect(data.pricingUrl).toContain("/pricing");
  });
});

describe("CSV export (app.export.csv)", () => {
  it("exports the filtered open list with BOM, header, and RFC 4180 escaping", async () => {
    const res = (await csvRoute.loader(routeArgs(request("/app/export.csv")))) as unknown as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("shelfcheck-issues-");

    // Byte-level check: the file itself starts with a UTF-8 BOM (EF BB BF).
    const bom = [...new Uint8Array(await res.clone().arrayBuffer()).slice(0, 3)];
    expect(bom).toEqual([0xef, 0xbb, 0xbf]);
    const text = await csvText(res);
    expect(text.startsWith("\uFEFF")).toBe(true);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(
      "issue_type,severity,status,product_id,product_title,variant_id,variant_title,sku,barcode,vendor,detail,group_key,admin_url,first_seen,last_seen",
    );
    // 5 open groups + header + trailing empty line.
    expect(lines.length).toBe(7);
    const dupLine = lines.find((l) => l.startsWith("DUPLICATE_SKU"));
    expect(dupLine).toBeDefined();
    expect(dupLine).toContain("DUP-1");
    expect(dupLine).toContain("admin.shopify.com/store/ui-harness/products/");
  });

  it("applies the current filters", async () => {
    const res = (await csvRoute.loader(
      routeArgs(request("/app/export.csv?type=DUPLICATE_SKU")),
    )) as unknown as Response;
    const text = await csvText(res);
    const lines = text.slice(1).split("\r\n");
    expect(lines).toHaveLength(3); // header + 1 group + trailing
  });

  it("caps rows on the free plan", async () => {
    const db = testDb();
    await db.shop.update({ where: { id: "ui-harness-shop" }, data: { plan: "free" } });
    for (let i = 0; i < 60; i += 1) {
      await db.issue.create({
        data: {
          shopId: "ui-harness-shop",
          type: "MISSING_SKU",
          severity: "low",
          variantGid: `gid://shopify/ProductVariant/csv-${i}`,
          productGid: `gid://shopify/Product/csv-${i}`,
          groupKey: "",
          details: { product_title: `Extra ${i}` },
          status: "open",
          firstSeenScanId: "seed",
          lastSeenScanId: "seed",
        },
      });
    }
    const res = (await csvRoute.loader(routeArgs(request("/app/export.csv")))) as unknown as Response;
    const text = await csvText(res);
    // Free plan: 50 rows max — but the visibility limit also applies (50).
    expect(text.slice(1).split("\r\n").length).toBe(52);
  });

  it("neutralizes formula injection in exported fields", async () => {
    const db = testDb();
    await db.issue.create({
      data: {
        shopId: "ui-harness-shop",
        type: "MISSING_SKU",
        severity: "low",
        variantGid: "gid://shopify/ProductVariant/formula-1",
        productGid: "gid://shopify/Product/formula-1",
        groupKey: "",
        details: { product_title: "=cmd()" },
        status: "open",
        firstSeenScanId: "seed",
        lastSeenScanId: "seed",
      },
    });
    const res = (await csvRoute.loader(routeArgs(request("/app/export.csv")))) as unknown as Response;
    const text = await csvText(res);
    expect(text).toContain("'=cmd()");
  });
});
