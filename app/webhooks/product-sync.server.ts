import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { adminGraphQL, unwrapData } from "../lib/admin-graphql.server.js";
import type { AdminGraphQLExecutor } from "../lib/admin-graphql.server.js";
import { normalizeSku, normalizeBarcode } from "../scan/normalize.js";
import { variantFingerprint } from "../scan/fingerprint.js";
import { rowRules } from "../detectors/row-rules.js";
import { parseDetectorOptions } from "../detectors/registry.js";
import type { DetectorResult } from "../detectors/types.js";
import { detectDuplicatesForValues } from "../detectors/duplicates.server.js";
import {
  upsertIssue,
  matchesIgnoreRules,
  type IgnoreRuleRow,
} from "../issues/lifecycle.server.js";
import { featureEnabled } from "../billing/gating.js";
import { logger } from "../lib/logger.server.js";

/**
 * Product watcher: refreshes ONE product's variants from Shopify and re-runs
 * detection for only what could have changed (spec <webhooks> "products/*"):
 *  - upsert the product's variants into variant_index (with fingerprints),
 *  - re-run row rules for those variants,
 *  - re-check duplicates ONLY for the old and new SKU/barcode values,
 *  - open/resolve issues accordingly.
 *
 * Loop protection (spec: "Never write to Shopify from webhook-driven work
 * without this check"): when every refreshed fingerprint equals the stored
 * one, detection is skipped entirely. Auto-tag's products/update round-trip
 * therefore lands here as a no-op (tags are not fingerprint inputs).
 */

export const PRODUCT_DEBOUNCE_MS = 30_000;

/** Single-product read mirroring the bulk query fields (frozen in bulk-query.ts). */
const PRODUCT_SYNC_QUERY = /* GraphQL */ `
  query ShelfCheckProductSync($id: ID!, $cursor: String) {
    product(id: $id) {
      id
      title
      vendor
      status
      isGiftCard
      variantsCount {
        count
      }
      availablePublicationsCount {
        count
      }
      variants(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          sku
          barcode
          price {
            amount
          }
          compareAtPrice {
            amount
          }
          inventoryPolicy
          inventoryQuantity
          inventoryItem {
            id
            tracked
            requiresShipping
            unitCost {
              amount
            }
            measurement {
              weight {
                value
                unit
              }
            }
          }
          media {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    }
  }
`;

const productPageSchema = z.object({
  product: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      vendor: z.string().nullable(),
      status: z.string().nullable(),
      isGiftCard: z.boolean().nullable(),
      variantsCount: z.object({ count: z.number().nullable() }).nullable(),
      availablePublicationsCount: z.object({ count: z.number().nullable() }).nullable(),
      variants: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean().nullable(), endCursor: z.string().nullable() }),
        nodes: z
          .array(
            z.object({
              id: z.string(),
              title: z.string().nullable(),
              sku: z.string().nullable(),
              barcode: z.string().nullable(),
              price: z.object({ amount: z.union([z.number(), z.string()]).nullable() }).nullable(),
              compareAtPrice: z.object({ amount: z.union([z.number(), z.string()]).nullable() }).nullable(),
              inventoryPolicy: z.string().nullable(),
              inventoryQuantity: z.number().nullable(),
              inventoryItem: z
                .object({
                  id: z.string(),
                  tracked: z.boolean().nullable(),
                  requiresShipping: z.boolean().nullable(),
                  unitCost: z.object({ amount: z.union([z.number(), z.string()]).nullable() }).nullable(),
                  measurement: z
                    .object({ weight: z.object({ value: z.number().nullable(), unit: z.string().nullable() }).nullable() })
                    .nullable(),
                })
                .nullable(),
              media: z
                .object({ edges: z.array(z.object({ node: z.object({ id: z.string() }) })) })
                .nullable(),
            }),
          )
          .nullable(),
      }),
    })
    .nullable(),
});

export interface SyncedVariantRow {
  shopId: string;
  variantGid: string;
  productGid: string;
  inventoryItemId: string | null;
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
  fingerprint: string;
}

/** Fetch one product's variants page by page (bounded). `shopId` is left blank. */
export async function fetchProductVariants(
  executor: AdminGraphQLExecutor,
  productGid: string,
  maxPages = 10,
): Promise<SyncedVariantRow[]> {
  const rows: SyncedVariantRow[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await adminGraphQL(executor, PRODUCT_SYNC_QUERY, { id: productGid, cursor });
    const data = unwrapData(response, (d) => productPageSchema.parse(d));
    const product = data.product;
    if (!product) return rows; // product deleted between webhook and sync

    const variantCount = product.variantsCount?.count ?? product.variants.nodes?.length ?? 0;
    const publications = product.availablePublicationsCount?.count ?? 0;
    for (const node of product.variants.nodes ?? []) {
      const weight = node.inventoryItem?.measurement?.weight?.value ?? null;
      rows.push({
        shopId: "",
        variantGid: node.id,
        productGid: product.id,
        inventoryItemId: node.inventoryItem?.id ?? null,
        productTitle: product.title ?? null,
        variantTitle: node.title ?? null,
        vendor: product.vendor ?? null,
        skuRaw: node.sku ?? null,
        skuNorm: normalizeSku(node.sku ?? null),
        barcode: normalizeBarcode(node.barcode ?? null) || null,
        price: node.price?.amount != null ? String(node.price.amount) : null,
        compareAtPrice: node.compareAtPrice?.amount != null ? String(node.compareAtPrice.amount) : null,
        productStatus: product.status ?? null,
        isGiftCard: product.isGiftCard ?? false,
        requiresShipping: node.inventoryItem?.requiresShipping ?? true,
        weightPresent: weight != null && weight > 0,
        costPresent: node.inventoryItem?.unitCost?.amount != null,
        hasImage: (node.media?.edges?.length ?? 0) > 0,
        variantCountOnProduct: variantCount,
        tracked: node.inventoryItem?.tracked ?? false,
        inventoryPolicy: node.inventoryPolicy ?? null,
        inventoryQty: node.inventoryQuantity ?? null,
        publishedAnyChannel: publications > 0,
        fingerprint: "",
      });
    }
    if (!product.variants.pageInfo?.hasNextPage) break;
    cursor = product.variants.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }
  return rows;
}

export interface ProductSyncResult {
  synced: number;
  unchanged: boolean;
  opened: number;
  resolved: number;
  removedVariants: number;
  skipped?: "free-plan";
}

/**
 * Refresh one product and re-run targeted detection. `shopId` is derived from
 * the persisted webhook event (never client input).
 */
export async function syncProduct(
  params: {
    shopId: string;
    productGid: string;
    executor: AdminGraphQLExecutor;
    client: PrismaClient;
    log?: Logger;
    now?: Date;
  },
): Promise<ProductSyncResult> {
  const { shopId, productGid, executor, client } = params;
  const log = params.log ?? logger;
  const now = params.now ?? new Date();

  const shop = await client.shop.findUnique({ where: { id: shopId } });
  if (!shop) return { synced: 0, unchanged: true, opened: 0, resolved: 0, removedVariants: 0 };
  if (shop.uninstalledAt) {
    return { synced: 0, unchanged: true, opened: 0, resolved: 0, removedVariants: 0 };
  }
  // Watchers are Starter/Pro only. On Free the event is recorded and nothing
  // else happens (spec <plans_and_limits>, acceptance 10).
  if (!featureEnabled(shop.plan, "watchers")) {
    log.debug({ shopId, productGid }, "product sync skipped: watchers not on plan");
    return { synced: 0, unchanged: true, opened: 0, resolved: 0, removedVariants: 0, skipped: "free-plan" };
  }

  const before = await client.variantIndex.findMany({ where: { shopId, productGid } });
  const beforeByGid = new Map(before.map((v) => [v.variantGid, v]));

  const rows = await fetchProductVariants(executor, productGid);
  for (const row of rows) row.shopId = shopId;

  // Product deleted upstream while we still have rows: keep index accurate.
  if (rows.length === 0 && before.length > 0 && !(await productExists(executor, productGid))) {
    return removeProductVariants({ shopId, productGid, client, now });
  }

  const unchanged =
    rows.length === before.length &&
    rows.every((row) => {
      row.fingerprint = variantFingerprint(row);
      return beforeByGid.get(row.variantGid)?.fingerprint === row.fingerprint;
    });

  if (unchanged) {
    log.debug({ shopId, productGid }, "product sync: fingerprints unchanged, skipping detection");
    return { synced: rows.length, unchanged: true, opened: 0, resolved: 0, removedVariants: 0 };
  }

  // Old values (for duplicate re-checks and resolution of vanished variants).
  const oldSkuNorms = [...new Set(before.map((v) => v.skuNorm ?? "").filter((s) => s !== ""))];
  const oldBarcodes = [...new Set(before.map((v) => v.barcode ?? "").filter((b) => b !== ""))];
  const newSkuNorms = [
    ...new Set(rows.map((r) => r.skuNorm ?? "").filter((s) => s !== "")),
  ];
  const newBarcodes = [
    ...new Set(rows.map((r) => r.barcode ?? "").filter((b) => b !== "")),
  ];

  // Upsert refreshed rows (small per-product sets: one round trip per row).
  for (const row of rows) {
    row.fingerprint = variantFingerprint(row);
    const { fingerprint, ...data } = row;
    await client.variantIndex.upsert({
      where: { shopId_variantGid: { shopId, variantGid: row.variantGid } },
      create: { ...data, fingerprint, updatedAt: now },
      update: { ...data, fingerprint, updatedAt: now },
    });
  }

  // Variants of this product that vanished (deleted variants): drop the row
  // and let their open issues resolve below.
  const newGids = new Set(rows.map((r) => r.variantGid));
  const vanished = before.filter((v) => !newGids.has(v.variantGid));
  if (vanished.length > 0) {
    await client.variantIndex.deleteMany({
      where: { shopId, variantGid: { in: vanished.map((v) => v.variantGid) } },
    });
  }

  const settings = (shop.settings ?? {}) as Record<string, unknown>;
  const options = parseDetectorOptions(settings);
  const rules = await client.ignoreRule.findMany({ where: { shopId } });
  const ruleRows: IgnoreRuleRow[] = rules.map((r) => ({
    scope: r.scope as IgnoreRuleRow["scope"],
    value: r.value,
    issueType: r.issueType,
  }));

  const findings: DetectorResult[] = [];
  const seenKeys = new Set<string>();
  const pushFinding = (f: DetectorResult) => {
    const key = `${f.type}\u0000${f.variantGid}\u0000${f.groupKey ?? ""}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    findings.push(f);
  };

  // Row rules for the refreshed variants.
  for (const row of rows) {
    for (const f of rowRules(row, options)) pushFinding(f);
  }
  // Targeted duplicates over old AND new values — every member of a
  // re-checked group gets its issue opened or kept (spec: "re-check
  // duplicates only for the SKUs and barcodes involved", all members).
  const duplicateFindings = await detectDuplicatesForValues(
    shopId,
    [...oldSkuNorms, ...newSkuNorms],
    [...oldBarcodes, ...newBarcodes],
    client,
  );
  for (const d of duplicateFindings) {
    if (!options.enabledIssueTypes.has(d.type)) continue;
    pushFinding({
      type: d.type,
      severity: d.severity,
      variantGid: d.variantGid,
      productGid: d.productGid,
      groupKey: d.groupKey,
      details: d.caseOrSpaceOnly ? { case_or_space_only: true } : {},
    });
  }

  // Apply ignore rules, upsert the rest.
  const memberByGid = new Map(rows.map((r) => [r.variantGid, r]));
  const beforeMemberByGid = new Map(before.map((v) => [v.variantGid, v]));
  let opened = 0;
  for (const f of findings) {
    const member = memberByGid.get(f.variantGid) ?? beforeMemberByGid.get(f.variantGid);
    if (member && matchesIgnoreRules(f, member as never, ruleRows)) continue;
    const outcome = await upsertIssue(shopId, `webhook:${now.getTime()}`, f, client, now);
    if (outcome === "opened") opened += 1;
  }

  // Resolution pass. Two scopes:
  //  1. duplicate issues in any value this event touched (old or new) — a
  //     group that dissolved must resolve EVERY member, including variants
  //     of other products,
  //  2. row-rule issues of this product's variants (including vanished ones).
  const stillProblematic = new Set(findings.map((f) => `${f.type}\u0000${f.variantGid}\u0000${f.groupKey ?? ""}`));
  let resolved = 0;

  const resolveIssue = async (id: string) => {
    await client.issue.update({ where: { id }, data: { status: "resolved", resolvedAt: now } });
    resolved += 1;
  };

  // 1a. DUPLICATE_SKU issues whose group value was involved.
  if (oldSkuNorms.length > 0 || newSkuNorms.length > 0) {
    const staleSku = await client.issue.findMany({
      where: {
        shopId,
        type: "DUPLICATE_SKU",
        groupKey: { in: [...new Set([...oldSkuNorms, ...newSkuNorms])] },
        status: { in: ["open", "snoozed"] },
      },
    });
    for (const issue of staleSku) {
      if (stillProblematic.has(`DUPLICATE_SKU\u0000${issue.variantGid}\u0000${issue.groupKey ?? ""}`)) continue;
      await resolveIssue(issue.id);
    }
  }
  // 1b. DUPLICATE_BARCODE issues likewise.
  if (oldBarcodes.length > 0 || newBarcodes.length > 0) {
    const staleBarcode = await client.issue.findMany({
      where: {
        shopId,
        type: "DUPLICATE_BARCODE",
        groupKey: { in: [...new Set([...oldBarcodes, ...newBarcodes])] },
        status: { in: ["open", "snoozed"] },
      },
    });
    for (const issue of staleBarcode) {
      if (stillProblematic.has(`DUPLICATE_BARCODE\u0000${issue.variantGid}\u0000${issue.groupKey ?? ""}`)) continue;
      await resolveIssue(issue.id);
    }
  }
  // 2. Row-rule issues of this product's variants that no longer fire.
  const productVariantGids = [
    ...newGids,
    ...vanished.map((v) => v.variantGid),
    ...before.map((v) => v.variantGid),
  ];
  if (productVariantGids.length > 0) {
    const staleRows = await client.issue.findMany({
      where: {
        shopId,
        variantGid: { in: [...new Set(productVariantGids)] },
        type: { notIn: ["DUPLICATE_SKU", "DUPLICATE_BARCODE"] },
        status: { in: ["open", "snoozed"] },
      },
    });
    for (const issue of staleRows) {
      if (stillProblematic.has(`${issue.type}\u0000${issue.variantGid}\u0000${issue.groupKey ?? ""}`)) continue;
      await resolveIssue(issue.id);
    }
  }

  log.info({ shopId, productGid, opened, resolved, removedVariants: vanished.length }, "product sync complete");
  return {
    synced: rows.length,
    unchanged: false,
    opened,
    resolved,
    removedVariants: vanished.length,
  };
}

/** Cheap existence probe used only to tell "0 variants" from "product gone". */
async function productExists(executor: AdminGraphQLExecutor, productGid: string): Promise<boolean> {
  const query = /* GraphQL */ `query ShelfCheckProductExists($id: ID!) { product(id: $id) { id } }`;
  try {
    const response = await adminGraphQL(executor, query, { id: productGid });
    const data = unwrapData(response, (d) => z.object({ product: z.object({ id: z.string() }).nullable() }).parse(d));
    return data.product != null;
  } catch {
    return true; // assume alive on error: never delete on a failed read
  }
}

/** Remove every variant of a deleted product and resolve their open issues. */
export async function removeProductVariants(
  params: { shopId: string; productGid: string; client: PrismaClient; now?: Date },
): Promise<ProductSyncResult> {
  const { shopId, productGid, client } = params;
  const now = params.now ?? new Date();
  const rows = await client.variantIndex.findMany({ where: { shopId, productGid } });
  if (rows.length === 0) {
    return { synced: 0, unchanged: true, opened: 0, resolved: 0, removedVariants: 0 };
  }
  const gids = rows.map((r) => r.variantGid);
  await client.variantIndex.deleteMany({ where: { shopId, variantGid: { in: gids } } });
  const resolved = await client.issue.updateMany({
    where: { shopId, variantGid: { in: gids }, status: { in: ["open", "snoozed"] } },
    data: { status: "resolved", resolvedAt: now },
  });
  return { synced: 0, unchanged: false, opened: 0, resolved: resolved.count, removedVariants: rows.length };
}
