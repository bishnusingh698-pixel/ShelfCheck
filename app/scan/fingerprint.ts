import { createHash } from "node:crypto";
import type { VariantRow } from "../detectors/types.js";

/**
 * Stable fingerprint of detector-relevant fields. Used for:
 *  - webhook loop protection (auto-tag fires products/update; if the
 *    recomputed fingerprint equals the stored one, do nothing),
 *  - cheap change detection.
 * Pure: same input → same hash across processes and versions.
 */

// as const keeps this a literal tuple, so Pick below takes only these fields.
const FIELDS = [
  "skuRaw",
  "barcode",
  "price",
  "compareAtPrice",
  "productStatus",
  "isGiftCard",
  "requiresShipping",
  "weightPresent",
  "costPresent",
  "hasImage",
  "variantCountOnProduct",
  "tracked",
  "inventoryPolicy",
  "inventoryQty",
  "publishedAnyChannel",
] as const;

export type FingerprintRow = Pick<VariantRow, (typeof FIELDS)[number]>;

export function variantFingerprint(row: FingerprintRow): string {
  const parts = FIELDS.map((field) => {
    const value = row[field];
    if (value == null) return "\u0000";
    return String(value);
  });
  return createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 32);
}
