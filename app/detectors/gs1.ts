/**
 * GS1 check-digit validation for GTIN-8 / GTIN-12 (UPC-A) / GTIN-13 (EAN-13) /
 * GTIN-14 (ITF-14). Pure.
 *
 * Rule (GS1 General Specifications): from the rightmost digit (excluding the
 * check digit), multiply alternately by 3 and 1; sum; check digit makes the
 * total a multiple of 10.
 */

export const GTIN_LENGTHS = [8, 12, 13, 14] as const;
export type GtinLength = (typeof GTIN_LENGTHS)[number];

export function isGtinLength(len: number): len is GtinLength {
  return (GTIN_LENGTHS as readonly number[]).includes(len);
}

/** Compute the GS1 mod-10 check digit for a numeric string of length 7/11/12/13. */
export function gs1CheckDigit(digits: string): number {
  // digits excludes the check digit.
  let sum = 0;
  for (let i = digits.length - 1, factor = 3; i >= 0; i--) {
    sum += Number(digits[i]) * factor;
    factor = factor === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Validate a full numeric GTIN (8/12/13/14 digits) including its check digit. */
export function isValidGtin(value: string): boolean {
  if (!/^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$/.test(value)) return false;
  const body = value.slice(0, -1);
  const check = Number(value.slice(-1));
  return gs1CheckDigit(body) === check;
}

export type BarcodeVerdict =
  | { kind: "empty" }
  | { kind: "valid" }
  | { kind: "invalid_length"; length: number }
  | { kind: "invalid_check_digit"; length: GtinLength }
  | { kind: "non_numeric" };

/** Classify a barcode's structure (before applying acceptNonGtin policy). */
export function classifyBarcode(raw: string | null): BarcodeVerdict {
  const value = (raw ?? "").trim();
  if (value === "") return { kind: "empty" };
  if (!/^[0-9]+$/.test(value)) return { kind: "non_numeric" };
  if (isGtinLength(value.length)) {
    return isValidGtin(value)
      ? { kind: "valid" }
      : { kind: "invalid_check_digit", length: value.length as GtinLength };
  }
  return { kind: "invalid_length", length: value.length };
}

/** Should this barcode raise INVALID_BARCODE given the accept-non-GTIN setting? */
export function barcodeIsInvalid(raw: string | null, acceptNonGtinBarcodes: boolean): boolean {
  const verdict = classifyBarcode(raw);
  if (acceptNonGtinBarcodes) {
    // Only flag GTIN-length numeric values that fail the check digit.
    return verdict.kind === "invalid_check_digit";
  }
  return (
    verdict.kind === "invalid_length" || verdict.kind === "invalid_check_digit" || verdict.kind === "non_numeric"
  );
}
