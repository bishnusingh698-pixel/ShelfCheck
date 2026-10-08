/**
 * Route-level integration tests for the Phase 8 UI server logic: the
 * dashboard loader (app._index) and the scan resource route (app.scan).
 *
 * These run the REAL route loaders/actions against the test database through
 * the UI harness seam (authenticateAdmin returns the seeded fixture session
 * when NODE_ENV=test + UI_HARNESS=1). Environment must be set before any app
 * module is imported, so every app import in this file is dynamic.
 */

process.env.UI_HARNESS = "1";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://openhands:openhands@127.0.0.1:5432/shelfcheck_test?connection_limit=5";

import "../helpers/shopify-test-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, disposeTestDb, testDb } from "../helpers/db.js";

type RouteModule = typeof import("../../app/routes/app.scan.js");
type IndexModule = typeof import("../../app/routes/app._index.js");
type LayoutModule = typeof import("../../app/routes/app.js");

let scanRoute: RouteModule;
let indexRoute: IndexModule;
let layoutRoute: LayoutModule;
let seed: typeof import("../../app/lib/ui-harness.server.js").seedUiHarnessFixture;

function harnessRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://app.example.com${path}`, init);
}

/** Loader/action args for direct route calls — the route code only reads
 *  `request` (and `params` for resource routes), so the router-injected
 *  context/url/pattern fields are stubs. */
function routeArgs(request: Request) {
  return {
    request,
    params: {},
    context: {},
    url: new URL(request.url),
    pattern: { path: request.url, basename: "/" },
  } as never;
}

function startPost(): Request {
  return harnessRequest("/app/scan", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "start" }).toString(),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  scanRoute = (await import("../../app/routes/app.scan.js")) as RouteModule;
  indexRoute = (await import("../../app/routes/app._index.js")) as IndexModule;
  layoutRoute = (await import("../../app/routes/app.js")) as LayoutModule;
  seed = (await import("../../app/lib/ui-harness.server.js")).seedUiHarnessFixture;
});

beforeEach(async () => {
  await resetDb();
  await seed(testDb());
});

afterAll(async () => {
  await disposeTestDb();
});

describe("dashboard loader (app._index)", () => {
  it("reads all aggregates from the stored scan row", async () => {
    const data = await indexRoute.loader(routeArgs(harnessRequest("/app")));

    expect(data.healthScore).toBe(72);
    expect(data.counts.high).toBe(2);
    expect(data.counts.medium).toBe(2);
    expect(data.counts.low).toBe(1);
    expect(data.counts.byType).toMatchObject({ MISSING_SKU: 2, MISSING_BARCODE: 2, MISSING_WEIGHT: 1 });
    expect(data.usage.analyzed).toBe(4821);
    expect(data.usage.cap).toBe(5000);
    expect(data.usage.overCapCount).toBe(0);
    expect(data.trend).toHaveLength(8);
    // Oldest first: Scan 1 is the first row.
    expect(data.trend[0].n).toBe(1);
    expect(data.trend[7].n).toBe(8);
    expect(data.onboarding.show).toBe(false);
    expect(data.scan.canScanNow).toBe(true);
    expect(data.scan.status).toBe("completed");
  });

  it("shows the onboarding checklist for a fresh install", async () => {
    const data = await indexRoute.loader(routeArgs(harnessRequest("/app?fixture=onboarding")));

    expect(data.onboarding.show).toBe(true);
    expect(data.onboarding.scanRunning).toBe(true);
    expect(data.healthScore).toBeNull();
    expect(data.scan.canScanNow).toBe(false);
    expect(data.scan.deniedReason).toBe("active");
    expect(data.scan.status).toBe("queued");
  });
});

describe("layout loader (app.tsx) locale resolution", () => {
  it("defaults to English for the fixture shop", async () => {
    const data = await layoutRoute.loader(routeArgs(harnessRequest("/app")));

    expect(data.locale).toBe("en");
    expect(data.harness).toBe(true);
    expect(data.messages["app.name"]).toBe("ShelfCheck");
  });

  it("honors ?locale=en-XA under the harness (Playwright pseudo project)", async () => {
    const data = await layoutRoute.loader(routeArgs(harnessRequest("/app?locale=en-XA")));

    // en-XA is a generated test-only locale: it must never leak to merchants,
    // but the harness renders it so e2e can catch missing translations.
    expect(data.locale).toBe("en-XA");
    expect(data.messages["app.tagline"]).toMatch(/[áéíóúñçÁÉÍÓÚÑÇ]/);
  });

  it("lets the merchant's saved admin language win over the URL locale", async () => {
    await testDb().shop.update({
      where: { id: "ui-harness-shop" },
      data: { uiLocale: "de" },
    });

    const data = await layoutRoute.loader(routeArgs(harnessRequest("/app?locale=fr")));

    expect(data.locale).toBe("de");
  });
});

describe("dashboard document title (meta)", () => {
  it("is localized through the layout loader's messages", async () => {
    const layout = await layoutRoute.loader(routeArgs(harnessRequest("/app")));
    const meta = indexRoute.meta({
      matches: [{ id: "routes/app", data: layout }],
    } as never);

    expect(meta).toEqual([{ title: "ShelfCheck — Catalog health" }]);
  });

  it("follows the pseudo locale when the harness selects it", async () => {
    const layout = await layoutRoute.loader(routeArgs(harnessRequest("/app?locale=en-XA")));
    const meta = indexRoute.meta({
      matches: [{ id: "routes/app", data: layout }],
    } as never);

    // The pseudo locale mangles and brackets every generated string (~33%
    // longer, accented) — that is its purpose: catch hard-coded strings and
    // overflow. The placeholder must still substitute.
    const [first] = meta ?? [];
    const title = (first as { title?: string } | undefined)?.title ?? "";
    expect(title).not.toBe("ShelfCheck — Catalog health");
    expect(title).toMatch(/[áéíóúñçÁÉÍÓÚÑÇ]/);
    expect(title).not.toContain("{title}");
    expect(title).not.toContain("dashboard.title");
  });
});

describe("scan resource route (app.scan)", () => {
  it("GET returns the latest scan status and the scan gate", async () => {
    const response = await scanRoute.loader(routeArgs(harnessRequest("/app/scan")));
    const body = await json(response);

    expect(body.scan).toMatchObject({ status: "completed", variantsAnalyzed: 4821 });
    expect(body.canScanNow).toBe(true);
    expect(body.deniedReason).toBeNull();
    expect(body.variantCap).toBe(5000);
  });

  it("POST starts a manual scan and enqueues scan_start", async () => {
    const db = testDb();
    const response = await scanRoute.action(routeArgs(startPost()));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);

    const scan = await db.scan.findFirst({
      where: { shop: { shopDomain: "ui-harness.myshopify.com" } },
      orderBy: { createdAt: "desc" },
    });
    expect(scan?.trigger).toBe("manual");
    expect(scan?.status).toBe("queued");

    const job = await db.job.findFirst({ where: { kind: "scan_start" } });
    expect(job?.status).toBe("pending");
  });

  it("POST is denied while a scan is active (one active scan per shop)", async () => {
    const response = await scanRoute.action(routeArgs(startPost()));
    expect(response.status).toBe(200);

    const second = await scanRoute.action(routeArgs(startPost()));
    const body = await json(second);
    expect(second.status).toBe(409);
    expect(body.reason).toBe("active");
  });

  it("POST on the onboarding fixture reports the already-queued install scan", async () => {
    const response = await scanRoute.action(
      routeArgs(
        harnessRequest("/app/scan?fixture=onboarding", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ intent: "start" }).toString(),
        }),
      ),
    );
    const body = await json(response);
    expect(response.status).toBe(409);
    expect(body.reason).toBe("active");
  });

  it("POST with a bad intent is rejected", async () => {
    const response = await scanRoute.action(
      routeArgs(
        harnessRequest("/app/scan", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ intent: "nope" }).toString(),
        }),
      ),
    );
    expect(response.status).toBe(400);
  });
});
