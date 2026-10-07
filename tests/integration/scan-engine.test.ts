import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  resetDb,
  disposeTestDb,
  testDb,
  createShop,
  createScan,
} from "../helpers/db.js";
import { streamJsonlIntoIndex } from "../../app/scan/jsonl-stream.server.js";
import { runDetection } from "../../app/scan/orchestrator.server.js";
import { reconcileAfterScan } from "../../app/scan/reconcile.server.js";
import { markIntentional, markIntentionalRegrowth, upsertIssue } from "../../app/issues/lifecycle.server.js";
import { EXPECTED_ISSUES, EXPECTED_TOTAL, seedVariantCount } from "../../scripts/seed-catalog.js";
import pino from "pino";

const logger = pino({ level: "silent" });

function fileStream(path: string) {
  // No encoding option: the stream must emit Buffers (bytes), because the
  // parser feeds chunks to TextDecoder.
  return async () =>
    Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}

function emptyStream() {
  return async () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

async function runScanFixture(shopId: string, settings: Record<string, unknown> = {}, cap?: number) {
  const db = testDb();
  const scan = await createScan(shopId, { status: "running" });
  const streamResult = await streamJsonlIntoIndex({
    shopId,
    scanId: scan.id,
    fetchFile: fileStream("tests/fixtures/seed-catalog.jsonl"),
    client: db,
    logger,
    variantCap: cap,
  });
  const detection = await runDetection({
    shopId,
    scanId: scan.id,
    settings,
    client: db,
    logger,
    streamResult: { variantsSeen: streamResult.variantsSeen, overCapCount: streamResult.overCapCount },
  });
  return { scan, streamResult, detection };
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

describe("JSONL parser + detectors (acceptance 1: exact counts)", () => {
  it("streams the fixture and produces EXACTLY the expected issue counts", async () => {
    const db = testDb();
    const shop = await createShop({});
    const { streamResult, detection } = await runScanFixture(shop.id);

    expect(streamResult.malformedLines).toBe(0);
    expect(streamResult.variantsSeen).toBe(seedVariantCount);
    expect(streamResult.overCapCount).toBe(0);
    expect(await db.variantIndex.count({ where: { shopId: shop.id } })).toBe(seedVariantCount);

    const issues = await db.issue.findMany({ where: { shopId: shop.id } });
    const byType: Record<string, number> = {};
    for (const issue of issues) byType[issue.type] = (byType[issue.type] ?? 0) + 1;
    for (const [type, expected] of Object.entries(EXPECTED_ISSUES)) {
      expect(byType[type] ?? 0, `type ${type}`).toBe(expected);
    }
    expect(issues.length).toBe(EXPECTED_TOTAL);
    expect(detection.opened).toBe(EXPECTED_TOTAL);

    // Archived product: no issues at all (default excludes archived).
    const archived = issues.filter((i) => i.productGid === "gid://shopify/Product/105");
    expect(archived.length).toBe(0);
  });

  it("flags case-only duplicate SKU groups with case_or_space_only=true", async () => {
    const db = testDb();
    const shop = await createShop({});
    await runScanFixture(shop.id);
    const group = await db.issue.findFirst({
      where: { shopId: shop.id, type: "DUPLICATE_SKU", groupKey: "cedar-planter-s" },
    });
    expect(group).not.toBeNull();
    expect((group!.details as Record<string, unknown>).case_or_space_only).toBe(true);
  });

  it("resolves everything on an empty rescan and reconciles the index", async () => {
    const db = testDb();
    const shop = await createShop({});
    await runScanFixture(shop.id);
    expect(await db.issue.count({ where: { shopId: shop.id, status: "open" } })).toBe(EXPECTED_TOTAL);

    // Empty rescan: all issues resolve; index reconciled to zero rows.
    const scan2 = await createScan(shop.id, { status: "running" });
    const empty = await streamJsonlIntoIndex({
      shopId: shop.id,
      scanId: scan2.id,
      fetchFile: emptyStream(),
      client: db,
      logger,
    });
    const d2 = await runDetection({
      shopId: shop.id,
      scanId: scan2.id,
      settings: {},
      client: db,
      logger,
      streamResult: { variantsSeen: 0, overCapCount: 0 },
    });
    expect(d2.resolved).toBe(EXPECTED_TOTAL);
    expect(await db.variantIndex.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await db.issue.count({ where: { shopId: shop.id, status: "open" } })).toBe(0);
    expect(empty.overCapCount).toBe(0);
  });

  it("respects the variant cap and never deletes unseen rows when over cap", async () => {
    const db = testDb();
    const shop = await createShop({});
    const { scan, streamResult } = await runScanFixture(shop.id, {}, 2);
    expect(streamResult.variantsSeen).toBe(2);
    expect(streamResult.overCapCount).toBe(seedVariantCount - 2);
    // Over-cap scan: reconcile must delete NOTHING.
    expect(await reconcileAfterScan(shop.id, scan.id, streamResult.overCapCount, db)).toBe(0);
    expect(await db.variantIndex.count({ where: { shopId: shop.id } })).toBe(2);
  });

  it("reopens a resolved issue when the problem returns (acceptance 3)", async () => {
    const db = testDb();
    const shop = await createShop({});
    await runScanFixture(shop.id);
    // Empty rescan resolves everything...
    const scan2 = await createScan(shop.id, { status: "running" });
    await streamJsonlIntoIndex({
      shopId: shop.id, scanId: scan2.id, fetchFile: emptyStream(), client: db, logger,
    });
    await runDetection({
      shopId: shop.id, scanId: scan2.id, settings: {}, client: db, logger,
      streamResult: { variantsSeen: 0, overCapCount: 0 },
    });
    expect(await db.issue.count({ where: { shopId: shop.id, status: "resolved" } })).toBe(EXPECTED_TOTAL);
    // ...and a rescan of the full catalog reopens every resolved issue.
    const { detection } = await runScanFixture(shop.id);
    expect(detection.opened).toBe(0); // no NEW issues — all are reopens of resolved rows
    expect(await db.issue.count({ where: { shopId: shop.id, status: "open" } })).toBe(EXPECTED_TOTAL);
    expect(await db.issue.count({ where: { shopId: shop.id, status: "resolved" } })).toBe(0);
  });
});

describe("intentional groups (acceptance 4)", () => {
  it("survives later scans; a new member reopens the group exactly once", async () => {
    const db = testDb();
    const shop = await createShop({});
    await runScanFixture(shop.id);

    // Mark the case-only DUPLICATE_SKU group intentional.
    const group = await db.issue.findMany({
      where: { shopId: shop.id, type: "DUPLICATE_SKU", groupKey: "cedar-planter-s" },
    });
    expect(group.length).toBe(2);
    await markIntentional(shop.id, group.map((g) => g.id), db);
    expect(
      await db.issue.count({ where: { shopId: shop.id, groupKey: "cedar-planter-s", status: "intentional" } }),
    ).toBe(2);

    // Later scan with the same group: intentional SURVIVES.
    await runScanFixture(shop.id);
    expect(
      await db.issue.count({ where: { shopId: shop.id, groupKey: "cedar-planter-s", status: "intentional" } }),
    ).toBe(2);

    // A third variant joins the group.
    const scan3 = await createScan(shop.id, { status: "running" });
    const grownFinding = {
      type: "DUPLICATE_SKU" as const,
      severity: "high" as const,
      variantGid: "gid://shopify/ProductVariant/1099",
      productGid: "gid://shopify/Product/108",
      groupKey: "cedar-planter-s",
      details: {},
    };
    await upsertIssue(shop.id, scan3.id, grownFinding, db);
    const regrown = await markIntentionalRegrowth(shop.id, [grownFinding], db);
    expect(regrown).toBe(1);
    // The two FORMER-intentional members reopen with group_grew; the new
    // member 1099 is simply a new open issue (it was never intentional).
    const grewFlagged = await db.issue.findMany({
      where: { shopId: shop.id, groupKey: "cedar-planter-s", status: "open" },
    });
    const reopened = grewFlagged.filter(
      (r) => (r.details as Record<string, unknown>).group_grew === true,
    );
    expect(reopened.length).toBe(2);
    expect(reopened.map((r) => r.variantGid).sort()).toEqual([
      "gid://shopify/ProductVariant/1021",
      "gid://shopify/ProductVariant/1022",
    ]);
    // Details merged, not replaced: case_or_space_only survives regrowth.
    expect(reopened.every((r) => (r.details as Record<string, unknown>).case_or_space_only === true)).toBe(true);
    // The new member is open too, without the group_grew flag.
    const newMember = await db.issue.findFirst({
      where: { shopId: shop.id, variantGid: "gid://shopify/ProductVariant/1099", status: "open" },
    });
    expect(newMember).not.toBeNull();
    expect((newMember!.details as Record<string, unknown>).group_grew).toBeUndefined();

    // Same grown group again: NO second regrowth.
    const regrownAgain = await markIntentionalRegrowth(shop.id, [grownFinding], db);
    expect(regrownAgain).toBe(0);
  });
});
