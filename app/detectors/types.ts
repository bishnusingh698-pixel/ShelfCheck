export type IssueType =
  | "MISSING_SKU"
  | "DUPLICATE_SKU"
  | "MISSING_BARCODE"
  | "DUPLICATE_BARCODE"
  | "INVALID_BARCODE"
  | "PUBLISHED_ZERO_INVENTORY"
  | "VARIANT_MISSING_IMAGE"
  | "MISSING_WEIGHT"
  | "MISSING_COST"
  | "COMPARE_AT_INVALID"
  | "ZERO_PRICE";

export type Severity = "high" | "medium" | "low";

export type IssueStatus = "open" | "snoozed" | "ignored" | "intentional" | "resolved";

export interface VariantRow {
  shopId: string;
  variantGid: string;
  productGid: string;
  productTitle: string | null;
  variantTitle: string | null;
  vendor: string | null;
  skuRaw: string | null;
  skuNorm: string | null;
  barcode: string | null;
  price: string | null;
  compareAtPrice: string | null;
  productStatus: string | null; // ACTIVE | DRAFT | ARCHIVED
  isGiftCard: boolean;
  requiresShipping: boolean;
  weightPresent: boolean;
  costPresent: boolean;
  hasImage: boolean;
  variantCountOnProduct: number;
  tracked: boolean;
  inventoryPolicy: string | null; // DENY | CONTINUE
  inventoryQty: number | null;
  publishedAnyChannel: boolean;
}

export interface DetectorResult {
  type: IssueType;
  severity: Severity;
  variantGid: string;
  productGid: string;
  groupKey: string | null;
  details: Record<string, unknown>;
}

export interface DetectorOptions {
  includeDraft: boolean;
  includeArchived: boolean;
  acceptNonGtinBarcodes: boolean;
  enabledIssueTypes: Set<IssueType>;
}
