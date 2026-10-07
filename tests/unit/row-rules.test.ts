import { describe, expect, it } from "vitest";
import { rowRules } from "../../app/detectors/row-rules.js";
import type { VariantRow, DetectorOptions } from "../../app/detectors/types.js";
import { defaultEnabledTypes } from "../../app/detectors/registry.js";
import { normalizeSku, skuIsEmpty, caseOrSpaceOnly, parsePrice } from "../../app/scan/normalize.js";

function makeRow(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    shopId: "shop1",
    variantGid: "gid://shopify/ProductVariant/1",
    productGid: "gid://shopify/Product/1",
    productTitle: "Widget",
    variantTitle: "Default",
    vendor: null,
    skuRaw: "SKU-1",
    skuNorm: "sku-1",
    barcode: "036000291452",
    price: "10.00",
    compareAtPrice: null,
    productStatus: "ACTIVE",
    isGiftCard: false,
    requiresShipping: true,
    weightPresent: true,
    costPresent: true,
    hasImage: true,
    variantCountOnProduct: 1,
    tracked: false,
    inventoryPolicy: null,
    inventoryQty: null,
    publishedAnyChannel: true,
    ...overrides,
  };
}

function options(overrides: Partial<DetectorOptions> = {}): DetectorOptions {
  return {
    includeDraft: true,
    includeArchived: false,
    acceptNonGtinBarcodes: false,
    enabledIssueTypes: defaultEnabledTypes(),
    ...overrides,
  };
}

describe("row rules", () => {
  it("clean row produces no issues", () => {
    expect(rowRules(makeRow(), options())).toEqual([]);
  });

  it("MISSING_SKU for empty and whitespace-only SKUs", () => {
    const types = rowRules(makeRow({ skuRaw: "   ", skuNorm: "" }), options()).map((r) => r.type);
    expect(types).toContain("MISSING_SKU");
    const types2 = rowRules(makeRow({ skuRaw: "", skuNorm: "" }), options()).map((r) => r.type);
    expect(types2).toContain("MISSING_SKU");
  });

  it("gift cards excluded from SKU, barcode, and weight checks", () => {
    const gift = makeRow({ isGiftCard: true, skuRaw: "", skuNorm: "", barcode: null, weightPresent: false, costPresent: false });
    const types = rowRules(gift, options()).map((r) => r.type);
    expect(types).not.toContain("MISSING_SKU");
    expect(types).not.toContain("MISSING_BARCODE");
    expect(types).not.toContain("MISSING_WEIGHT");
    expect(types).not.toContain("MISSING_COST");
  });

  it("MISSING_BARCODE for empty barcode", () => {
    const types = rowRules(makeRow({ barcode: "" }), options()).map((r) => r.type);
    expect(types).toContain("MISSING_BARCODE");
  });

  it("INVALID_BARCODE with scientific notation hint", () => {
    const results = rowRules(makeRow({ barcode: "8.71E+12" }), options());
    const invalid = results.find((r) => r.type === "INVALID_BARCODE");
    expect(invalid?.details.hint).toBe("scientific_notation");
  });

  it("PUBLISHED_ZERO_INVENTORY requires ACTIVE, published, tracked, DENY, qty<=0", () => {
    const base = { tracked: true, inventoryPolicy: "DENY" as const, inventoryQty: 0, publishedAnyChannel: true, productStatus: "ACTIVE" };
    expect(rowRules(makeRow(base), options()).map((r) => r.type)).toContain("PUBLISHED_ZERO_INVENTORY");

    // Untracked → never flagged
    expect(rowRules(makeRow({ ...base, tracked: false }), options()).map((r) => r.type)).not.toContain("PUBLISHED_ZERO_INVENTORY");
    // Continue selling → never flagged
    expect(rowRules(makeRow({ ...base, inventoryPolicy: "CONTINUE" }), options()).map((r) => r.type)).not.toContain("PUBLISHED_ZERO_INVENTORY");
    // Draft product → not published-zero-inventory
    expect(rowRules(makeRow({ ...base, productStatus: "DRAFT" }), options()).map((r) => r.type)).not.toContain("PUBLISHED_ZERO_INVENTORY");
    // Unpublished → not flagged
    expect(rowRules(makeRow({ ...base, publishedAnyChannel: false }), options()).map((r) => r.type)).not.toContain("PUBLISHED_ZERO_INVENTORY");
    // Positive inventory → not flagged
    expect(rowRules(makeRow({ ...base, inventoryQty: 5 }), options()).map((r) => r.type)).not.toContain("PUBLISHED_ZERO_INVENTORY");
  });

  it("VARIANT_MISSING_IMAGE only for products with 2+ variants", () => {
    const single = rowRules(makeRow({ variantCountOnProduct: 1, hasImage: false }), options());
    expect(single.map((r) => r.type)).not.toContain("VARIANT_MISSING_IMAGE");
    const multi = rowRules(makeRow({ variantCountOnProduct: 3, hasImage: false }), options());
    expect(multi.map((r) => r.type)).toContain("VARIANT_MISSING_IMAGE");
  });

  it("MISSING_WEIGHT for shipping variants without weight; non-shipping exempt", () => {
    expect(rowRules(makeRow({ weightPresent: false }), options()).map((r) => r.type)).toContain("MISSING_WEIGHT");
    expect(rowRules(makeRow({ weightPresent: false, requiresShipping: false }), options()).map((r) => r.type)).not.toContain("MISSING_WEIGHT");
  });

  it("COMPARE_AT_INVALID reason lower vs equal", () => {
    const lower = rowRules(makeRow({ compareAtPrice: "9.00", price: "10.00" }), options()).find((r) => r.type === "COMPARE_AT_INVALID");
    expect(lower?.details.reason).toBe("lower");
    const equal = rowRules(makeRow({ compareAtPrice: "10.00", price: "10.00" }), options()).find((r) => r.type === "COMPARE_AT_INVALID");
    expect(equal?.details.reason).toBe("equal");
    // Higher compare-at is fine
    expect(rowRules(makeRow({ compareAtPrice: "12.00", price: "10.00" }), options()).map((r) => r.type)).not.toContain("COMPARE_AT_INVALID");
  });

  it("ZERO_PRICE off by default, on when enabled", () => {
    expect(rowRules(makeRow({ price: "0.00" }), options()).map((r) => r.type)).not.toContain("ZERO_PRICE");
    const enabled = new Set(defaultEnabledTypes());
    enabled.add("ZERO_PRICE");
    expect(rowRules(makeRow({ price: "0.00" }), options({ enabledIssueTypes: enabled })).map((r) => r.type)).toContain("ZERO_PRICE");
  });

  it("archived excluded unless enabled", () => {
    const row = makeRow({ productStatus: "ARCHIVED", skuRaw: "", skuNorm: "" });
    expect(rowRules(row, options()).map((r) => r.type)).not.toContain("MISSING_SKU");
    expect(rowRules(row, options({ includeArchived: true })).map((r) => r.type)).toContain("MISSING_SKU");
  });

  it("draft included by default, excludable", () => {
    const row = makeRow({ productStatus: "DRAFT", skuRaw: "", skuNorm: "" });
    expect(rowRules(row, options()).map((r) => r.type)).toContain("MISSING_SKU");
    expect(rowRules(row, options({ includeDraft: false })).map((r) => r.type)).not.toContain("MISSING_SKU");
  });

  it("disabled types produce nothing", () => {
    const row = makeRow({ skuRaw: "", skuNorm: "", barcode: "", weightPresent: false });
    const none = options({ enabledIssueTypes: new Set() });
    expect(rowRules(row, none)).toEqual([]);
  });
});

describe("normalization", () => {
  it("trims, collapses whitespace, lowercases", () => {
    expect(normalizeSku("  AB   C  ")).toBe("ab c");
    expect(skuIsEmpty("   ")).toBe(true);
    expect(skuIsEmpty("a")).toBe(false);
  });
  it("caseOrSpaceOnly detection", () => {
    expect(caseOrSpaceOnly("ABC-1", "abc-1")).toBe(true);
    expect(caseOrSpaceOnly("ABC 1", "abc-1")).toBe(false);
    expect(caseOrSpaceOnly("", "")).toBe(false);
  });
  it("parsePrice handles null, empty, bad, good", () => {
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
    expect(parsePrice("10.50")).toBe(10.5);
  });
});
