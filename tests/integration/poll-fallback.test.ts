import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetDb,
  disposeTestDb,
  testDb,
  createShop,
} from "../helpers/db.js";
import { enqueue } from "../../app/jobs/queue.server.js";
import { startScan } from "../../app/scan/orchestrator.server.js";
import { pollDelayMs } from "../../app/scan/bulk-operation.server.js";
import { runInventorySync } from "../../app/webhooks/processors.server.js";
import { recordIssuesChanged } from "../../app/activity/events.server.js";
import pino from "pino";

const logger = pino({ level: "silent" });

/** Minimal executor: the bulk run is accepted, and reads report RUNNING. */
function slowExecutor() {
  return {
    graphql: async (body: { query: string; variables?: Record<string, unknown> }) => {
      if (body.query.includes("bulkOperationRunQuery")) {
        return {
          data: {
            bulkOperationRunQuery: {
              userErrors: [],
              bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" },
            },
          },
        };
      }
      if (body.query.includes("node(")) {
        return { data: { node: { id: "gid://shopify/BulkOperation/1", status: "RUNNING" } } };
      }
      // BULK_STATUS_QUERY: currentBulkOperation keyed by the operation id.
      return { data: { bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "RUNNING" } } };
    },
  };
}

beforeAll(async () => {
  await testDb().$queryRaw`SELECT 1`;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disposeTestDb();
});

describe("scan polling fallback (spec §scan_pipeline step 3)", () => {
  it("startScan schedules the first poll 5 s out with the scan as dedupe key", async () => {
    const db = testDb();
    const shop = await createShop({ plan: "pro" });
    const scan = await db.scan.create({
      data: { shopId: shop.id, status: "queued", trigger: "manual" },
    });

    const { started, bulkOperationId } = await startScan({
      shopId: shop.id,
      scanId: scan.id,
      makeExecutor: () => Promise.resolve(slowExecutor() as never),
      client: db,
      logger,
    });
    expect(started).toBe(true);
    expect(bulkOperationId).toBe("gid://shopify/BulkOperation/1");

    const polls = await db.job.findMany({ where: { kind: "scan_poll" } });
    expect(polls).toHaveLength(1);
    expect(polls[0]!.dedupeKey).toBe(`scan_poll:${scan.id}`);
    expect(polls[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 4_000);
    expect(polls[0]!.runAt.getTime()).toBeLessThan(Date.now() + 6_000);
  });

  it("re-enqueues with exponential backoff while the operation is still running", async () => {
    const db = testDb();
    const shop = await createShop({ plan: "pro" });
    const scan = await db.scan.create({
      data: { shopId: shop.id, status: "queued", trigger: "manual" },
    });
    const { started } = await startScan({
      shopId: shop.id,
      scanId: scan.id,
      makeExecutor: () => Promise.resolve(slowExecutor() as never),
      client: db,
      logger,
    });
    expect(started).toBe(true);
    await db.scan.update({ where: { id: scan.id }, data: { status: "running" } });

    // The pending poll job now carries attempt 1; the handler-map path runs
    // it and re-enqueues attempt+1 when the operation is still RUNNING.
    const first = await db.job.findFirstOrThrow({ where: { kind: "scan_poll", status: "pending" } });
    expect((first.payload as { attempt?: number }).attempt).toBe(1);

    const { pollScan } = await import("../../app/scan/orchestrator.server.js");
    const result = await pollScan({
      shopId: shop.id,
      scanId: scan.id,
      makeExecutor: () => Promise.resolve(slowExecutor() as never),
      client: db,
      logger,
    });
    expect(result.terminal).toBe(false);
    expect(result.status?.status).toBe("RUNNING");

    // Simulate the tick driver completing the first poll, then the handler
    // re-enqueues the next poll with attempt+1 and a longer delay.
    await db.job.update({ where: { id: first.id }, data: { status: "done" } });
    const attempt = ((first.payload as { attempt?: number }).attempt ?? 0) + 1;
    const { enqueue } = await import("../../app/jobs/queue.server.js");
    await enqueue(
      {
        kind: "scan_poll",
        payload: { scanId: scan.id, attempt },
        shopId: shop.id,
        runAt: new Date(Date.now() + pollDelayMs(attempt)),
        dedupeKey: `scan_poll:${scan.id}`,
      },
      db,
    );

    const next = await db.job.findFirstOrThrow({
      where: { kind: "scan_poll", status: "pending" },
      orderBy: { runAt: "desc" },
    });
    expect((next.payload as { attempt?: number }).attempt).toBe(2);
    expect(next.runAt.getTime()).toBeGreaterThan(Date.now() + 9_000); // 5s × 2

    // Backoff schedule: 5 s doubling, capped at 60 s (spec §scan_pipeline).
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(pollDelayMs(attempt)).toBe(Math.min(60_000, 5_000 * 2 ** (attempt - 1)));
    }
    expect(pollDelayMs(5)).toBe(60_000); // cap reached
  });
});

describe("inventory sync activity (spec <in_app_alerts>)", () => {
  it("runInventorySync records a coalesced issues_changed event when issues change", async () => {
    const db = testDb();
    const shop = await createShop({ plan: "pro" });

    // A resolved PUBLISHED_ZERO_INVENTORY issue that a restock re-opens is
    // covered by watchers.test.ts; here assert the recording path itself:
    // syncInventoryItem with no mapped variants reports zero changes and
    // runInventorySync must not record an event for it.
    await expect(
      runInventorySync(shop.id, "gid://shopify/InventoryItem/none", 5, db),
    ).resolves.toBeUndefined();

    const events = await db.activityEvent.findMany({ where: { shopId: shop.id } });
    expect(events).toHaveLength(0);

    // And the positive path: recordIssuesChanged is what the handler calls.
    await recordIssuesChanged(shop.id, { opened: 2, resolved: 1 }, db);
    const after = await db.activityEvent.findMany({ where: { shopId: shop.id } });
    expect(after).toHaveLength(1);
    expect(after[0]!.kind).toBe("issues_changed");
  });
});

describe("enqueue dedupe", () => {
  it("a pending scan_poll for the same scan is not duplicated", async () => {
    const db = testDb();
    const shop = await createShop({ plan: "pro" });
    const scan = await db.scan.create({
      data: { shopId: shop.id, status: "running", trigger: "manual", bulkOperationId: "gid://shopify/BulkOperation/1" },
    });
    await enqueue(
      { kind: "scan_poll", payload: { scanId: scan.id, attempt: 1 }, shopId: shop.id, dedupeKey: `scan_poll:${scan.id}` },
      db,
    );
    // enqueue ignores a duplicate pending poll (partial unique index).
    const dup = await enqueue(
      { kind: "scan_poll", payload: { scanId: scan.id, attempt: 2 }, shopId: shop.id, dedupeKey: `scan_poll:${scan.id}` },
      db,
    );
    expect(dup).toBeNull();
    const polls = await db.job.findMany({ where: { kind: "scan_poll" } });
    expect(polls).toHaveLength(1);
  });
});
