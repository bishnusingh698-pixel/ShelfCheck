import type { PrismaClient } from "@prisma/client";

/**
 * Reconciliation: delete variant_index rows NOT seen in the just-finished scan.
 *
 * The guard conditions (spec §scan_pipeline step 6, known pitfall "Deleting
 * unseen variants after a failed, partial, or over-cap scan"):
 *  1. only after a scan completed successfully,
 *  2. only when over_cap_count is zero for the rows being deleted — if the
 *     scan stopped at the cap, rows beyond the cap were never marked seen,
 *     so a blanket delete would destroy valid index data for those variants.
 * In the over-cap case we keep ALL rows (never delete) so webhook watchers
 * can still refresh them; the next full scan reconciles.
 */
export async function reconcileAfterScan(
  shopId: string,
  scanId: string,
  overCapCount: number,
  client: PrismaClient,
): Promise<number> {
  if (overCapCount > 0) return 0;
  const result = await client.variantIndex.deleteMany({
    where: { shopId, seenScanId: { not: scanId } },
  });
  return result.count;
}
