import type { PrismaClient } from "@prisma/client";
import type { IssueType, Severity } from "./types.js";

/**
 * Set-based SQL duplicate detection over variant_index.
 * Full scan: GROUP BY over the whole index.
 * Targeted (webhook refresh): only the SKU/barcode values involved.
 */

export interface DuplicateFinding {
  type: IssueType; // DUPLICATE_SKU | DUPLICATE_BARCODE
  severity: Severity;
  variantGid: string;
  productGid: string;
  groupKey: string;
  caseOrSpaceOnly: boolean;
}

interface RawDuplicateRow {
  sku_norm: string | null;
  barcode: string | null;
  variant_gid: string;
  product_gid: string;
  sku_raw: string | null;
}

function rowsToFindings(rows: RawDuplicateRow[], type: IssueType, severity: Severity): DuplicateFinding[] {
  const groups = new Map<string, RawDuplicateRow[]>();
  for (const row of rows) {
    const key = type === "DUPLICATE_SKU" ? (row.sku_norm ?? "") : (row.barcode ?? "");
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const findings: DuplicateFinding[] = [];
  for (const [key, members] of groups) {
    // Case/whitespace-only: raw SKUs differ but normalized values match.
    const rawSet = new Set(members.map((m) => (m.sku_raw ?? "").trim()));
    const caseOrSpaceOnly =
      type === "DUPLICATE_SKU" && rawSet.size > 1;
    for (const member of members) {
      findings.push({
        type,
        severity,
        variantGid: member.variant_gid,
        productGid: member.product_gid,
        groupKey: key,
        caseOrSpaceOnly,
      });
    }
  }
  return findings;
}

/** Full duplicate detection for a completed scan (gift cards excluded). */
export async function detectDuplicates(
  shopId: string,
  scanId: string,
  client: PrismaClient,
): Promise<DuplicateFinding[]> {
  const skuRows = await client.$queryRaw<RawDuplicateRow[]>`
    SELECT v."skuNorm" AS sku_norm, v."barcode", v."variantGid" AS variant_gid,
           v."productGid" AS product_gid, v."skuRaw" AS sku_raw
    FROM "VariantIndex" v
    JOIN (
      SELECT "skuNorm" AS k FROM "VariantIndex"
      WHERE "shopId" = ${shopId} AND "seenScanId" = ${scanId}
        AND "isGiftCard" = false AND "skuNorm" IS NOT NULL AND "skuNorm" <> ''
      GROUP BY "skuNorm" HAVING COUNT(*) > 1
    ) d ON v."skuNorm" = d.k
    WHERE v."shopId" = ${shopId} AND v."seenScanId" = ${scanId} AND v."isGiftCard" = false
    ORDER BY v."skuNorm", v."variantGid"
  `;
  const barcodeRows = await client.$queryRaw<RawDuplicateRow[]>`
    SELECT v."skuNorm" AS sku_norm, v."barcode", v."variantGid" AS variant_gid,
           v."productGid" AS product_gid, v."skuRaw" AS sku_raw
    FROM "VariantIndex" v
    JOIN (
      SELECT "barcode" AS k FROM "VariantIndex"
      WHERE "shopId" = ${shopId} AND "seenScanId" = ${scanId}
        AND "isGiftCard" = false AND "barcode" IS NOT NULL AND "barcode" <> ''
      GROUP BY "barcode" HAVING COUNT(*) > 1
    ) d ON v."barcode" = d.k
    WHERE v."shopId" = ${shopId} AND v."seenScanId" = ${scanId} AND v."isGiftCard" = false
    ORDER BY v."barcode", v."variantGid"
  `;
  return [
    ...rowsToFindings(skuRows, "DUPLICATE_SKU", "high"),
    ...rowsToFindings(barcodeRows, "DUPLICATE_BARCODE", "high"),
  ];
}

/**
 * Targeted duplicate detection (webhook refresh): only variants sharing the
 * given SKU norms or barcodes (old and new values both included).
 */
export async function detectDuplicatesForValues(
  shopId: string,
  skuNorms: string[],
  barcodes: string[],
  client: PrismaClient,
): Promise<DuplicateFinding[]> {
  const findings: DuplicateFinding[] = [];
  const skuSet = [...new Set(skuNorms.filter((s) => s !== ""))];
  const barcodeSet = [...new Set(barcodes.filter((b) => b !== ""))];

  for (const sku of skuSet) {
    const rows = await client.$queryRaw<RawDuplicateRow[]>`
      SELECT "skuNorm" AS sku_norm, "barcode", "variantGid" AS variant_gid,
             "productGid" AS product_gid, "skuRaw" AS sku_raw
      FROM "VariantIndex"
      WHERE "shopId" = ${shopId} AND "skuNorm" = ${sku} AND "isGiftCard" = false
      ORDER BY "variantGid"
    `;
    if (rows.length > 1) {
      findings.push(...rowsToFindings(rows, "DUPLICATE_SKU", "high"));
    }
  }
  for (const barcode of barcodeSet) {
    const rows = await client.$queryRaw<RawDuplicateRow[]>`
      SELECT "skuNorm" AS sku_norm, "barcode", "variantGid" AS variant_gid,
             "productGid" AS product_gid, "skuRaw" AS sku_raw
      FROM "VariantIndex"
      WHERE "shopId" = ${shopId} AND "barcode" = ${barcode} AND "isGiftCard" = false
      ORDER BY "variantGid"
    `;
    if (rows.length > 1) {
      findings.push(...rowsToFindings(rows, "DUPLICATE_BARCODE", "high"));
    }
  }
  return findings;
}
