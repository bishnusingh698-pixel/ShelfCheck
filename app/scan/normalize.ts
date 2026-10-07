/**
 * Normalization (pure).
 * sku_norm = trim + collapse inner whitespace + lowercase.
 * Empty or whitespace-only → missing SKU.
 */

export function normalizeSku(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function skuIsEmpty(skuRaw: string | null | undefined): boolean {
  return normalizeSku(skuRaw) === "";
}

/** Barcode normalization: trim only (case irrelevant; never lowercase digits). */
export function normalizeBarcode(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

/** Do two raw SKUs differ ONLY by case or whitespace (same sku_norm)? */
export function caseOrSpaceOnly(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeSku(a);
  const nb = normalizeSku(b);
  return na !== "" && na === nb && (a ?? "") !== (b ?? "");
}

/** Parse a price string safely to a number (Shopify returns decimal strings). */
export function parsePrice(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
