import type { IssueType, Severity } from "./types.js";

/**
 * Issue type registry: default severity and default enabled state.
 * ZERO_PRICE is off by default (it is an "extra" detector; many merchants
 * legitimately sell free items).
 */

export const ISSUE_REGISTRY: Record<IssueType, { severity: Severity; defaultEnabled: boolean }> = {
  MISSING_SKU: { severity: "high", defaultEnabled: true },
  DUPLICATE_SKU: { severity: "high", defaultEnabled: true },
  MISSING_BARCODE: { severity: "medium", defaultEnabled: true },
  DUPLICATE_BARCODE: { severity: "high", defaultEnabled: true },
  INVALID_BARCODE: { severity: "medium", defaultEnabled: true },
  PUBLISHED_ZERO_INVENTORY: { severity: "medium", defaultEnabled: true },
  VARIANT_MISSING_IMAGE: { severity: "low", defaultEnabled: true },
  MISSING_WEIGHT: { severity: "medium", defaultEnabled: true },
  MISSING_COST: { severity: "low", defaultEnabled: true },
  COMPARE_AT_INVALID: { severity: "medium", defaultEnabled: true },
  ZERO_PRICE: { severity: "low", defaultEnabled: false },
};

export const ALL_ISSUE_TYPES = Object.keys(ISSUE_REGISTRY) as IssueType[];

export function defaultEnabledTypes(): Set<IssueType> {
  return new Set(ALL_ISSUE_TYPES.filter((t) => ISSUE_REGISTRY[t].defaultEnabled));
}

export function severityOf(type: IssueType): Severity {
  return ISSUE_REGISTRY[type].severity;
}
