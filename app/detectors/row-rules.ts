import type { DetectorResult, DetectorOptions, IssueType, VariantRow } from "./types.js";
import { barcodeIsInvalid } from "./gs1.js";
import { barcodeHints } from "./barcode-hints.js";
import { parsePrice } from "../scan/normalize.js";

/**
 * Per-variant row rules (pure). Duplicates (DUPLICATE_SKU, DUPLICATE_BARCODE)
 * are computed in SQL over the whole index; everything else is a row rule.
 *
 * Exclusions that apply to EVERY check here (applied by the caller passing a
 * filtered set):
 *  - gift cards are excluded from SKU, barcode, and weight checks,
 *  - archived products are excluded unless includeArchived,
 *  - drafts are included unless includeDraft is false.
 */

export function rowRules(row: VariantRow, options: DetectorOptions): DetectorResult[] {
  const results: DetectorResult[] = [];
  const enabled = options.enabledIssueTypes;
  const isDraft = row.productStatus === "DRAFT";
  const isArchived = row.productStatus === "ARCHIVED";
  if (isArchived && !options.includeArchived) return results;
  if (isDraft && !options.includeDraft) return results;

  const push = (
    type: IssueType,
    severity: DetectorResult["severity"],
    details: Record<string, unknown> = {},
    groupKey: string | null = null,
  ) => {
    if (!enabled.has(type)) return;
    results.push({
      type,
      severity,
      variantGid: row.variantGid,
      productGid: row.productGid,
      groupKey,
      details,
    });
  };

  // MISSING_SKU: empty or whitespace-only SKU. Gift cards excluded.
  if (!row.isGiftCard && (row.skuNorm ?? "") === "") {
    push("MISSING_SKU", "high");
  }

  // MISSING_BARCODE: gift cards excluded.
  if (!row.isGiftCard && (row.barcode ?? "") === "") {
    push("MISSING_BARCODE", "medium");
  }

  // INVALID_BARCODE with hints.
  if (!row.isGiftCard && (row.barcode ?? "") !== "") {
    if (barcodeIsInvalid(row.barcode, options.acceptNonGtinBarcodes)) {
      const details: Record<string, unknown> = {};
      const hints = barcodeHints(row.barcode);
      if (hints.length > 0) details.hint = hints[0];
      push("INVALID_BARCODE", "medium", details);
    }
  }

  // PUBLISHED_ZERO_INVENTORY: ACTIVE + published + tracked + DENY + qty<=0.
  if (
    row.productStatus === "ACTIVE" &&
    row.publishedAnyChannel &&
    row.tracked &&
    row.inventoryPolicy === "DENY" &&
    (row.inventoryQty ?? 0) <= 0
  ) {
    push("PUBLISHED_ZERO_INVENTORY", "medium");
  }

  // VARIANT_MISSING_IMAGE: product has 2+ variants and this variant lacks media.
  if (row.variantCountOnProduct >= 2 && !row.hasImage) {
    push("VARIANT_MISSING_IMAGE", "low");
  }

  // MISSING_WEIGHT: ships but weight missing/0. Gift cards never ship.
  if (!row.isGiftCard && row.requiresShipping && !row.weightPresent) {
    push("MISSING_WEIGHT", "medium");
  }

  // MISSING_COST (spec excludes gift cards only from SKU/barcode/weight checks;
  // D-19 records that gift cards will typically always flag here).
  if (!row.costPresent) {
    push("MISSING_COST", "low");
  }

  // COMPARE_AT_INVALID: compareAtPrice present and <= price.
  const price = parsePrice(row.price);
  const compareAt = parsePrice(row.compareAtPrice);
  if (price != null && compareAt != null && compareAt <= price) {
    push("COMPARE_AT_INVALID", "medium", { reason: compareAt === price ? "equal" : "lower" });
  }

  // ZERO_PRICE (extra, off by default): ACTIVE product with price 0.
  if (row.productStatus === "ACTIVE") {
    const p = parsePrice(row.price);
    if (p != null && p === 0) {
      push("ZERO_PRICE", "low");
    }
  }

  return results;
}

/** Run row rules over many rows. */
export function runRowRules(rows: VariantRow[], options: DetectorOptions): DetectorResult[] {
  return rows.flatMap((row) => rowRules(row, options));
}
