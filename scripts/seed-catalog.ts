import { z } from "zod";

/**
 * Seed catalog: the single source of truth for the seeded dev store AND the
 * generated JSONL fixtures. The EXPECTED_ISSUES object is asserted by an
 * integration test: the detectors must produce EXACTLY these counts.
 */

export interface SeedVariant {
  id: number;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  inventoryQuantity: number | null;
  tracked: boolean;
  requiresShipping: boolean;
  weightValue: number | null;
  unitCost: string | null;
  hasMedia: boolean;
  giftCard?: boolean;
  status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
  publishedCount?: number;
  vendor?: string;
}

export interface SeedProduct {
  id: number;
  title: string;
  vendor: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  isGiftCard: boolean;
  variants: SeedVariant[];
}

export const SEED_CATALOG: SeedProduct[] = [
  {
    id: 100,
    title: "Aurora Desk Lamp",
    vendor: "Northlight",
    status: "ACTIVE",
    isGiftCard: false,
    variants: [
      { id: 1001, title: "Black", sku: "ADL-001", barcode: "01234567890128", price: "49.00", compareAtPrice: null, inventoryPolicy: "DENY", inventoryQuantity: 12, tracked: true, requiresShipping: true, weightValue: 1.2, unitCost: "18.00", hasMedia: true, publishedCount: 2 },
      { id: 1002, title: "White", sku: "ADL-002", barcode: "01234567890135", price: "49.00", compareAtPrice: "39.00", inventoryPolicy: "DENY", inventoryQuantity: 0, tracked: true, requiresShipping: true, weightValue: 1.2, unitCost: "18.00", hasMedia: true, publishedCount: 2 },
    ],
  },
  {
    id: 101,
    title: "Harbor Mug Set",
    vendor: "Northlight",
    status: "ACTIVE",
    isGiftCard: false,
    variants: [
      { id: 1011, title: "Set of 4", sku: "HMS-004", barcode: null, price: "24.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", inventoryQuantity: 30, tracked: true, requiresShipping: true, weightValue: 0.9, unitCost: "9.00", hasMedia: true, publishedCount: 1 },
      { id: 1012, title: "Set of 6", sku: "HMS-006", barcode: "8.71E+12", price: "34.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", inventoryQuantity: 30, tracked: true, requiresShipping: true, weightValue: 0.9, unitCost: "9.00", hasMedia: false, publishedCount: 1 },
    ],
  },
  {
    id: 102,
    title: "Cedar Planter",
    vendor: "Fernwood",
    status: "ACTIVE",
    isGiftCard: false,
    variants: [
      { id: 1021, title: "Small", sku: "  cedar-planter-s  ", barcode: "12345678", price: "18.00", compareAtPrice: "18.00", inventoryPolicy: "DENY", inventoryQuantity: 5, tracked: true, requiresShipping: true, weightValue: null, unitCost: null, hasMedia: true, publishedCount: 1 },
      { id: 1022, title: "Large", sku: "CEDAR-PLANTER-S", barcode: "4006381333930", price: "28.00", compareAtPrice: "24.00", inventoryPolicy: "DENY", inventoryQuantity: 0, tracked: true, requiresShipping: false, weightValue: 0, unitCost: "11.00", hasMedia: true, publishedCount: 1 },
      { id: 1023, title: "Medium", sku: "CP-002", barcode: "12345678", price: "22.00", compareAtPrice: null, inventoryPolicy: "DENY", inventoryQuantity: 2, tracked: true, requiresShipping: true, weightValue: 1.0, unitCost: "8.00", hasMedia: true, publishedCount: 1 },
    ],
  },
  {
    id: 103,
    title: "Storm Umbrella",
    vendor: "Northlight",
    status: "ACTIVE",
    isGiftCard: false,
    variants: [
      { id: 1031, title: "Navy", sku: "SU-NAVY", barcode: "12345678901", price: "32.00", compareAtPrice: null, inventoryPolicy: "DENY", inventoryQuantity: 0, tracked: true, requiresShipping: true, weightValue: 0.5, unitCost: "12.00", hasMedia: true, publishedCount: 1 },
    ],
  },
  {
    id: 104,
    title: "Draft Notebook",
    vendor: "Fernwood",
    status: "DRAFT",
    isGiftCard: false,
    variants: [
      { id: 1041, title: "Dotted", sku: null, barcode: null, price: "12.00", compareAtPrice: null, inventoryPolicy: "DENY", inventoryQuantity: 40, tracked: false, requiresShipping: true, weightValue: 0.3, unitCost: "4.00", hasMedia: true, publishedCount: 0 },
    ],
  },
  {
    id: 105,
    title: "Archived Lantern",
    vendor: "Fernwood",
    status: "ARCHIVED",
    isGiftCard: false,
    variants: [
      { id: 1051, title: "Default", sku: "AL-001", barcode: "98765432109873", price: "45.00", compareAtPrice: null, inventoryPolicy: "DENY", inventoryQuantity: 0, tracked: true, requiresShipping: true, weightValue: 1.1, unitCost: "20.00", hasMedia: true, publishedCount: 0 },
    ],
  },
  {
    id: 106,
    title: "Gift Card",
    vendor: "Store",
    status: "ACTIVE",
    isGiftCard: true,
    variants: [
      { id: 1061, title: "$25", sku: null, barcode: null, price: "25.00", compareAtPrice: null, inventoryPolicy: "DENY", inventoryQuantity: 100, tracked: false, requiresShipping: false, weightValue: null, unitCost: null, hasMedia: false, publishedCount: 1, giftCard: true },
    ],
  },
  {
    id: 107,
    title: "Trail Bottle",
    vendor: "Northlight",
    status: "ACTIVE",
    isGiftCard: false,
    variants: [
      { id: 1071, title: "500ml", sku: "TB-500", barcode: "01234567890128", price: "19.00", compareAtPrice: null, inventoryPolicy: "CONTINUE", inventoryQuantity: 0, tracked: true, requiresShipping: true, weightValue: 0.4, unitCost: "7.00", hasMedia: true, publishedCount: 1 },
      { id: 1072, title: "750ml", sku: "TB-750", barcode: "1234567", price: "23.00", compareAtPrice: "23.00", inventoryPolicy: "DENY", inventoryQuantity: 8, tracked: true, requiresShipping: true, weightValue: 0.6, unitCost: "8.00", hasMedia: true, publishedCount: 1 },
      { id: 1073, title: "1000ml", sku: "TB-1000", barcode: "123456789012", price: "27.00", compareAtPrice: "29.00", inventoryPolicy: "DENY", inventoryQuantity: 4, tracked: true, requiresShipping: true, weightValue: 0.8, unitCost: "9.00", hasMedia: true, publishedCount: 0 },
    ],
  },
];

export const seedVariantCount = SEED_CATALOG.reduce((sum, p) => sum + p.variants.length, 0);

/**
 * Exact expected issue counts for the seed catalog under DEFAULT settings:
 * draft included, archived excluded, strict GTIN mode, ZERO_PRICE off,
 * gift cards excluded from SKU/barcode/weight checks only (spec wording).
 *
 * Hand-derived per variant (barcode check-digit math verified against the
 * GS1 mod-10 rule; the integration test re-asserts these against the real
 * detectors — any mismatch is investigated, never patched blindly):
 *  1001 ADL-001: valid GTIN-14 barcode → none
 *  1002 ADL-002: COMPARE_AT_INVALID(lower), PUBLISHED_ZERO_INVENTORY
 *  1011 HMS-004: MISSING_BARCODE
 *  1012 HMS-006: INVALID_BARCODE(sci-notation hint), VARIANT_MISSING_IMAGE
 *  1021 Small:   MISSING_WEIGHT, MISSING_COST, COMPARE_AT_INVALID(equal),
 *                INVALID_BARCODE(GTIN-8 check fails), DUPLICATE_BARCODE,
 *                DUPLICATE_SKU (case/space-only pair with 1022)
 *  1022 Large:   COMPARE_AT_INVALID(lower), INVALID_BARCODE(EAN-13 fails),
 *                PUBLISHED_ZERO_INVENTORY, DUPLICATE_SKU (pair with 1021)
 *  1023 Medium:  DUPLICATE_BARCODE (12345678 with 1021), INVALID_BARCODE
 *  1031 SU-NAVY: INVALID_BARCODE(11 digits, dropped-zero hint),
 *                PUBLISHED_ZERO_INVENTORY
 *  1041 Draft:   MISSING_SKU, MISSING_BARCODE (drafts are included by default)
 *  1051 Archived: excluded
 *  1061 Gift card: MISSING_COST (cost check has no gift-card exclusion in spec)
 *  1071 TB-500:  DUPLICATE_BARCODE (01234567890128 with 1001) — CONTINUE policy
 *                so no zero-inventory flag despite qty 0
 *  1072 TB-750:  INVALID_BARCODE(7 digits), COMPARE_AT_INVALID(equal)
 *  1073 TB-1000: 123456789012 is a VALID UPC-A check digit → none
 */
export const EXPECTED_ISSUES: Record<string, number> = {
  MISSING_SKU: 1,
  DUPLICATE_SKU: 2,
  MISSING_BARCODE: 2,
  DUPLICATE_BARCODE: 4,
  INVALID_BARCODE: 6,
  PUBLISHED_ZERO_INVENTORY: 3,
  VARIANT_MISSING_IMAGE: 1,
  MISSING_WEIGHT: 1,
  MISSING_COST: 2,
  COMPARE_AT_INVALID: 4,
  ZERO_PRICE: 0,
};

export const EXPECTED_TOTAL = Object.values(EXPECTED_ISSUES).reduce((a, b) => a + b, 0);

/** zod schema validating that generated fixtures stay in sync with this file. */
export const seedCatalogSchema = z.array(
  z.object({
    id: z.number(),
    title: z.string(),
    vendor: z.string(),
    status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]),
    isGiftCard: z.boolean(),
    variants: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        sku: z.string().nullable(),
        barcode: z.string().nullable(),
        price: z.string(),
        compareAtPrice: z.string().nullable(),
        inventoryPolicy: z.enum(["DENY", "CONTINUE"]),
        inventoryQuantity: z.number().nullable(),
        tracked: z.boolean(),
        requiresShipping: z.boolean(),
        weightValue: z.number().nullable(),
        unitCost: z.string().nullable(),
        hasMedia: z.boolean(),
        giftCard: z.boolean().optional(),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
        publishedCount: z.number().optional(),
        vendor: z.string().optional(),
      }),
    ),
  }),
);

export const VALIDATED_CATALOG = seedCatalogSchema.parse(SEED_CATALOG);
