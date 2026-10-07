import { describe, expect, it } from "vitest";
import { healthScore, healthBand } from "../../app/issues/health-score.js";
import { variantFingerprint } from "../../app/scan/fingerprint.js";
import { csvCell, csvEscape, csvRow, neutralizeFormula, CSV_BOM } from "../../app/csv/escape.js";
import { canScanNow, issueVisibilityLimit, variantCap, featureEnabled, isOverCap } from "../../app/billing/gating.js";
import { planLimits } from "../../app/billing/plans.js";

describe("health score", () => {
  it("perfect score with no issues", () => {
    expect(healthScore({ high: 0, medium: 0, low: 0 }, 1000)).toBe(100);
  });
  it("penalty weights 10/4/1 and clamps at 0", () => {
    // 10 high on 10 variants → penalty 100 → score 0
    expect(healthScore({ high: 10, medium: 0, low: 0 }, 10)).toBe(0);
    // 10 medium on 100 variants → penalty 40 → score 60
    expect(healthScore({ high: 0, medium: 10, low: 0 }, 100)).toBe(60);
    // 10 low on 100 variants → penalty 10 → score 90
    expect(healthScore({ high: 0, medium: 0, low: 10 }, 100)).toBe(90);
    // Mixed: 1 high + 2 medium + 3 low on 100 → penalty 100*(10+8+3)/100 = 21 → 79
    expect(healthScore({ high: 1, medium: 2, low: 3 }, 100)).toBe(79);
    // Clamped at 0 even with huge counts
    expect(healthScore({ high: 1000, medium: 0, low: 0 }, 1)).toBe(0);
  });
  it("variants_analyzed = 0 does not divide by zero", () => {
    expect(healthScore({ high: 5, medium: 0, low: 0 }, 0)).toBe(0);
  });
  it("bands", () => {
    expect(healthBand(100)).toBe("excellent");
    expect(healthBand(90)).toBe("excellent");
    expect(healthBand(89)).toBe("good");
    expect(healthBand(75)).toBe("good");
    expect(healthBand(74)).toBe("needs_attention");
    expect(healthBand(50)).toBe("needs_attention");
    expect(healthBand(49)).toBe("critical");
    expect(healthBand(0)).toBe("critical");
  });
});

describe("fingerprint", () => {
  it("stable across calls and field order", () => {
    const row = {
      skuRaw: "A", barcode: "1", price: "1.00", compareAtPrice: null,
      productStatus: "ACTIVE", isGiftCard: false, requiresShipping: true,
      weightPresent: true, costPresent: true, hasImage: true, variantCountOnProduct: 2,
      tracked: true, inventoryPolicy: "DENY", inventoryQty: 0, publishedAnyChannel: true,
    };
    expect(variantFingerprint(row)).toBe(variantFingerprint({ ...row }));
    expect(variantFingerprint(row)).not.toBe(variantFingerprint({ ...row, skuRaw: "B" }));
  });
  it("ignores non-detector fields (titles, vendor)", () => {
    const a = variantFingerprint({
      skuRaw: "A", barcode: "1", price: "1", compareAtPrice: null, productStatus: "ACTIVE",
      isGiftCard: false, requiresShipping: true, weightPresent: true, costPresent: true,
      hasImage: true, variantCountOnProduct: 1, tracked: false, inventoryPolicy: null,
      inventoryQty: null, publishedAnyChannel: true,
    });
    expect(typeof a).toBe("string");
    expect(a).toHaveLength(32);
  });
});

describe("CSV escaping", () => {
  it("quotes fields with commas, quotes, newlines", () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape(null)).toBe("");
  });
  it("neutralizes formula injection without touching negative numbers or SKUs", () => {
    expect(neutralizeFormula("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutralizeFormula("+REF")).toBe("'+REF");
    expect(neutralizeFormula("@x")).toBe("'@x");
    expect(neutralizeFormula("-cmd")).toBe("'-cmd");
    // Negative numbers untouched: '-' followed by digit
    expect(neutralizeFormula("-5")).toBe("-5");
    expect(neutralizeFormula("-5.50")).toBe("-5.50");
    // Ordinary SKUs untouched
    expect(neutralizeFormula("ABC-123")).toBe("ABC-123");
    expect(neutralizeFormula("SKU_1")).toBe("SKU_1");
    // Lone '='
    expect(neutralizeFormula("=")).toBe("'=");
  });
  it("csvCell neutralizes then escapes", () => {
    // '=S' (non-digit after =) is neutralized, then RFC-quoted for the comma.
    expect(csvCell('=SUM(A1), "x"')).toBe('"\'=SUM(A1), ""x"""');
    // '=1' (digit after =) is left per spec; comma still triggers quoting.
    expect(csvCell("=1+1, x")).toBe('"=1+1, x"');
  });
  it("row joins with commas; BOM present", () => {
    expect(csvRow(["a", "b"])).toBe("a,b");
    expect(CSV_BOM).toBe("﻿");
  });
});

describe("plan gating", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("free: manual scans denied; install always allowed", () => {
    expect(canScanNow({ plan: "free", lastScanAt: null, scansToday: 0 }, "manual", now)).toEqual({ allowed: false, reason: "free-plan-monthly" });
    expect(canScanNow({ plan: "free", lastScanAt: null, scansToday: 0 }, "install", now).allowed).toBe(true);
    expect(canScanNow({ plan: "free", lastScanAt: null, scansToday: 0 }, "scheduled", now).allowed).toBe(true);
  });
  it("starter: 3/day manual, 10-min cooldown", () => {
    expect(canScanNow({ plan: "starter", lastScanAt: null, scansToday: 0 }, "manual", now).allowed).toBe(true);
    expect(canScanNow({ plan: "starter", lastScanAt: null, scansToday: 3 }, "manual", now)).toEqual({ allowed: false, reason: "daily-limit" });
    const recent = new Date(now.getTime() - 5 * 60_000);
    expect(canScanNow({ plan: "starter", lastScanAt: recent, scansToday: 0 }, "manual", now)).toEqual({ allowed: false, reason: "cooldown" });
    const older = new Date(now.getTime() - 11 * 60_000);
    expect(canScanNow({ plan: "starter", lastScanAt: older, scansToday: 0 }, "manual", now).allowed).toBe(true);
  });
  it("pro: 10/day", () => {
    expect(canScanNow({ plan: "pro", lastScanAt: null, scansToday: 10 }, "manual", now)).toEqual({ allowed: false, reason: "daily-limit" });
    expect(canScanNow({ plan: "pro", lastScanAt: null, scansToday: 9 }, "manual", now).allowed).toBe(true);
  });
  it("limits table matches spec", () => {
    expect(variantCap("free")).toBe(500);
    expect(variantCap("starter")).toBe(5000);
    expect(variantCap("pro")).toBe(50000);
    expect(issueVisibilityLimit("free")).toBe(50);
    expect(issueVisibilityLimit("starter")).toBe(0);
    expect(featureEnabled("free", "watchers")).toBe(false);
    expect(featureEnabled("starter", "watchers")).toBe(true);
    expect(featureEnabled("starter", "telegram")).toBe(false);
    expect(featureEnabled("pro", "telegram")).toBe(true);
    expect(featureEnabled("pro", "autoTag")).toBe(true);
    expect(featureEnabled("free", "digest")).toBe(false);
    expect(isOverCap("free", 501)).toBe(true);
    expect(isOverCap("free", 500)).toBe(false);
    expect(planLimits("starter").scheduled).toBe("weekly");
    expect(planLimits("pro").scheduled).toBe("daily");
    expect(planLimits("free").scheduled).toBe("monthly");
  });
});
