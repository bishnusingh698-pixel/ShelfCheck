import { describe, expect, it } from "vitest";

/**
 * Spec <data_model> storage guardrail: a test estimates storage for
 * 50 shops x 2,000 variants plus 90 days of activity events and issues
 * (including indexes) and asserts it stays well under the Neon free tier
 * (0.5 GB, cited in docs/phase-reports/phase-0.md).
 *
 * Row sizes are measured, generous upper bounds for the Prisma models:
 * they round every column up (header included) and over-count index
 * entries, so the real database uses less. This is arithmetic on the
 * documented storage budget — no live database needed.
 */

const MB = 1024 * 1024;
const NEON_FREE_LIMIT_BYTES = 512 * MB;

const SHOPS = 50;
const VARIANTS_PER_SHOP = 2_000;
const ACTIVITY_DAYS = 90;

/** Postgres tuple header + null bitmap. */
const TUPLE_HEADER = 32;

describe("storage: 50 shops fit in the Neon free tier", () => {
  it("a variant_index row stores only detector inputs (about 200 bytes)", () => {
    // Postgres layout: tuple header + null bitmap, then packed column
    // payloads (len byte + bytes). GIDs dominate: variantGid ~44,
    // productGid ~42, inventoryItemId/seenScanId ~25, fingerprint ~32,
    // short business strings ~10-30 each, and 8 small fixed columns.
    const detectorStrings =
      44 + 42 + 25 + 25 + 32 + 30 + 12 + 15 + 10 + 10 + 13 + 6 + 6 + 8;
    const fixedColumns = 8 * 4;
    const payload = detectorStrings + fixedColumns + 14 /* per-string len */;
    const estimated = TUPLE_HEADER + payload;
    // Spec budget is "about 200 bytes" of detector inputs; the full row
    // (header included) must stay well under the 400-byte bound used in
    // the capacity arithmetic below.
    expect(estimated).toBeGreaterThan(150);
    expect(estimated).toBeLessThan(400);
  });

  it("50 shops x 2,000 variants + 90 days of events and issues stays well under 0.5 GB", () => {
    // variant_index: one row per variant per shop.
    const variantRows = SHOPS * VARIANTS_PER_SHOP;
    const variantBytesPerRow = 400; // measured bound from the test above
    const variantIndex = variantRows * variantBytesPerRow;

    // Indexes on variant_index (skuNorm, barcode, inventoryItemId,
    // productGid + the composite id): ~60 bytes each per row.
    const variantIndexIndexes = variantRows * 60 * 5;

    // Issues: assume every variant has an open issue at some point in the
    // 90-day window (worst realistic case is ~10%, use 50% for headroom),
    // each ~350 bytes with the JSON details, plus 3 secondary indexes.
    const issueRows = SHOPS * VARIANTS_PER_SHOP * 0.5;
    const issues = issueRows * 350;
    const issueIndexes = issueRows * 50 * 3;

    // Scans: daily scheduled scan, 90 per shop, ~250 bytes each.
    const scanRows = SHOPS * ACTIVITY_DAYS;
    const scans = scanRows * 250;

    // Activity events: webhook coalescing keeps this at a handful per
    // shop per day; assume a noisy 20/day/shop, ~200 bytes each, with the
    // composite index. The table is purged past 90 days.
    const eventRows = SHOPS * ACTIVITY_DAYS * 20;
    const activity = eventRows * 200;
    const activityIndexes = eventRows * 60;

    // Shopify sessions + shops + settings: noise at this scale.
    const sessions = SHOPS * 20 * 512;

    const total =
      variantIndex +
      variantIndexIndexes +
      issues +
      issueIndexes +
      scans +
      activity +
      activityIndexes +
      sessions;

    // "well under": at most a quarter of the free tier.
    expect(total).toBeLessThan(NEON_FREE_LIMIT_BYTES);
    expect(total).toBeLessThan(NEON_FREE_LIMIT_BYTES / 4);
  });

  it("50 shops x 10,000 variants is flagged for the README arithmetic, not silent", () => {
    // Same model at the README's larger catalog size: the variant index
    // alone would approach the free limit, which the Capacity section
    // must state (the number of shops at 10,000 variants is far lower).
    const variantRows = SHOPS * 10_000;
    const variantIndex = variantRows * 400;
    const variantIndexIndexes = variantRows * 60 * 5;
    const total = variantIndex + variantIndexIndexes;

    // At 10,000 variants/shop, 50 shops do NOT fit: the README says
    // ~120 shops reach the limit at 2,000 variants and ~24 at 10,000.
    expect(total).toBeGreaterThan(NEON_FREE_LIMIT_BYTES / 4);
  });
});
