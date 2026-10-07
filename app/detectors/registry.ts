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

/**
 * Parse DetectorOptions from the shop settings jsonb. Missing keys fall back
 * to spec defaults: draft included, archived excluded, strict GTIN checks,
 * registry defaults for enabled types.
 */
export function parseDetectorOptions(settings: Record<string, unknown>): {
  includeDraft: boolean;
  includeArchived: boolean;
  acceptNonGtinBarcodes: boolean;
  enabledIssueTypes: Set<IssueType>;
} {
  const enabledRaw = settings["enabled_issue_types"];
  const enabled =
    Array.isArray(enabledRaw)
      ? new Set(enabledRaw.filter((t): t is IssueType => typeof t === "string" && t in ISSUE_REGISTRY))
      : defaultEnabledTypes();
  return {
    includeDraft: settings["include_draft"] !== false,
    includeArchived: settings["include_archived"] === true,
    acceptNonGtinBarcodes: settings["accept_non_gtin_barcodes"] === true,
    enabledIssueTypes: enabled,
  };
}
