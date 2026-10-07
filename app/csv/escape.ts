/**
 * RFC 4180 CSV escaping plus formula-injection neutralization (pure).
 * CSV columns stay English; the `detail` text may be localized.
 */

const FORMULA_PREFIXES = ["=", "+", "@", "-"];

/** Escape a field per RFC 4180 (quote when needed; double quotes inside). */
export function csvEscape(field: string | null | undefined): string {
  const value = field ?? "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Neutralize spreadsheet formula injection: a cell starting with =, +, @, or -
 * followed by a non-digit gets a leading single quote... but ordinary data
 * (negative numbers, SKUs like "ABC-123") must not be altered.
 *
 * Rule (per spec): prefix with ' only when the first char is one of = + @ -
 * AND the next char is NOT a digit. "-" followed by a digit is a negative
 * number and stays untouched.
 */
export function neutralizeFormula(field: string | null | undefined): string {
  const value = field ?? "";
  if (value.length >= 2 && FORMULA_PREFIXES.includes(value[0]) && !/[0-9]/.test(value[1])) {
    return `'${value}`;
  }
  // Single-char formulas like "=" alone are also dangerous.
  if (value.length === 1 && FORMULA_PREFIXES.includes(value)) {
    return `'${value}`;
  }
  return value;
}

/** Escape + neutralize in one step (the order matters: neutralize first). */
export function csvCell(field: string | null | undefined): string {
  return csvEscape(neutralizeFormula(field));
}

export const CSV_COLUMNS = [
  "issue_type",
  "severity",
  "status",
  "product_id",
  "product_title",
  "variant_id",
  "variant_title",
  "sku",
  "barcode",
  "vendor",
  "detail",
  "group_key",
  "admin_url",
  "first_seen",
  "last_seen",
] as const;

export function csvRow(fields: Array<string | null | undefined>): string {
  return fields.map((f) => csvCell(f)).join(",");
}

/** UTF-8 BOM so Excel detects encoding. */
export const CSV_BOM = "\uFEFF";
