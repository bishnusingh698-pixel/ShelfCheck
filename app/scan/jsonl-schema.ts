import { z } from "zod";

/**
 * zod schemas for each JSONL line type the bulk query produces.
 *
 * Shopify bulk JSONL rules (docs/api-notes.md §3):
 *  - one object per line
 *  - plain-object children are inlined into the parent line
 *  - nested-connection children (media) come as separate lines with
 *    __parentId pointing at the variant
 *  - numbers may be missing (null) for optional fields
 *
 * Money fields: bulk output inlines scalar-only selections as the amount value
 * directly (price: 10.0). We accept both the bare amount and the object form
 * to be resilient, then normalize to a string.
 */

const amountSchema = z.union([
  z.number(),
  z.string(),
  z.null(),
]);

/** Normalize a money value (bulk emits the amount scalar) to a decimal string or null. */
export function moneyToString(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  return String(value);
}

export const variantLineSchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  price: amountSchema,
  compareAtPrice: amountSchema,
  inventoryPolicy: z.string().nullable(),
  inventoryQuantity: z.number().nullable(),
  product: z.object({
    id: z.string(),
    title: z.string().nullable(),
    vendor: z.string().nullable(),
    status: z.string().nullable(),
    isGiftCard: z.boolean(),
    variantsCount: z.object({ count: z.number().nullable() }).nullable(),
    availablePublicationsCount: z.object({ count: z.number().nullable() }).nullable(),
  }),
  inventoryItem: z.object({
    id: z.string(),
    tracked: z.boolean().nullable(),
    requiresShipping: z.boolean().nullable(),
    unitCost: z.object({ amount: amountSchema }).nullable(),
    measurement: z
      .object({ weight: z.object({ value: z.number().nullable(), unit: z.string().nullable() }).nullable() })
      .nullable(),
  }).nullable(),
  __parentId: z.string().optional(),
});

export const mediaLineSchema = z.object({
  __parentId: z.string(),
  id: z.string(),
  mediaType: z.string().optional(),
});

export type VariantLine = z.infer<typeof variantLineSchema>;
export type MediaLine = z.infer<typeof mediaLineSchema>;

/** Classify a parsed JSON line. Returns null when it matches neither type. */
export function classifyLine(obj: unknown): VariantLine | MediaLine | null {
  const maybe = obj as Record<string, unknown> | null;
  if (!maybe || typeof maybe !== "object") return null;
  if (typeof maybe.__parentId === "string" && typeof maybe.id === "string" && !("product" in maybe)) {
    const media = mediaLineSchema.safeParse(obj);
    if (media.success) return media.data;
    return null;
  }
  const variant = variantLineSchema.safeParse(obj);
  if (variant.success) return variant.data;
  return null;
}

/** Parsed, in-memory representation of one variant for upsert. */
export interface ParsedVariant {
  shopId: string;
  variantGid: string;
  productGid: string;
  inventoryItemId: string;
  productTitle: string | null;
  variantTitle: string | null;
  vendor: string | null;
  skuRaw: string | null;
  skuNorm: string | null;
  barcode: string | null;
  price: string | null;
  compareAtPrice: string | null;
  productStatus: string | null;
  isGiftCard: boolean;
  requiresShipping: boolean;
  weightPresent: boolean;
  costPresent: boolean;
  hasImage: boolean;
  variantCountOnProduct: number;
  tracked: boolean;
  inventoryPolicy: string | null;
  inventoryQty: number | null;
  publishedAnyChannel: boolean;
}

/** Convert a validated variant JSONL line (+ media count) into a ParsedVariant. */
export function toParsedVariant(
  line: VariantLine,
  shopId: string,
  mediaCount: number,
): ParsedVariant {
  const weight = line.inventoryItem?.measurement?.weight?.value ?? null;
  const publications = line.product.availablePublicationsCount?.count ?? 0;
  return {
    shopId,
    variantGid: line.id,
    productGid: line.product.id,
    inventoryItemId: line.inventoryItem?.id ?? "",
    productTitle: line.product.title ?? null,
    variantTitle: line.title ?? null,
    vendor: line.product.vendor ?? null,
    skuRaw: line.sku ?? null,
    skuNorm: null, // filled by normalize in the stream stage
    barcode: line.barcode ?? null,
    price: moneyToString(line.price ?? null),
    compareAtPrice: moneyToString(line.compareAtPrice ?? null),
    productStatus: line.product.status ?? null,
    isGiftCard: line.product.isGiftCard === true,
    requiresShipping: line.inventoryItem?.requiresShipping === true,
    weightPresent: weight != null && weight > 0,
    costPresent: line.inventoryItem?.unitCost?.amount != null,
    hasImage: mediaCount > 0,
    variantCountOnProduct: line.product.variantsCount?.count ?? 1,
    tracked: line.inventoryItem?.tracked === true,
    inventoryPolicy: line.inventoryPolicy ?? null,
    inventoryQty: line.inventoryQuantity ?? null,
    publishedAnyChannel: publications > 0,
  };
}
