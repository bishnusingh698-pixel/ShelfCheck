/**
 * Barcode hints (pure). Suggestions only; never written back to Shopify.
 */

export type BarcodeHint =
  | "scientific_notation"
  | "likely_dropped_leading_zero"
  | "inner_whitespace";

export function barcodeHints(rawBarcode: string | null): BarcodeHint[] {
  const hints: BarcodeHint[] = [];
  const value = rawBarcode ?? "";
  if (!value) return hints;

  // Scientific notation: e.g. "8.71E+12" — classic CSV export corruption.
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(value.trim())) {
    hints.push("scientific_notation");
  }

  // Whitespace inside (not just around).
  if (/\S\s+\S/.test(value)) {
    hints.push("inner_whitespace");
  }

  // 11-digit numeric: likely a UPC-A that lost its leading zero in Excel.
  const trimmed = value.trim();
  if (/^[0-9]{11}$/.test(trimmed)) {
    hints.push("likely_dropped_leading_zero");
  }

  return hints;
}

/** Expand a hint into human-readable detail keys (localized in the UI layer). */
export function hintDetailKey(hint: BarcodeHint): string {
  return `hint.${hint}`;
}
