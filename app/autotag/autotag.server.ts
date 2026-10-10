import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { adminGraphQL, unwrapData } from "../lib/admin-graphql.server.js";
import type { AdminGraphQLExecutor } from "../lib/admin-graphql.server.js";
import { featureEnabled } from "../billing/gating.js";
import { logger } from "../lib/logger.server.js";

/**
 * Auto-tag: the ONLY write ShelfCheck can make to Shopify — adding or
 * removing the product tag `shelfcheck-fix`, and only when a Pro merchant
 * opted in AND holds the optional write_products scope (spec <hard_constraints> 3/5).
 *
 * Loop protection (spec <webhooks>): tagging fires products/update; the
 * watcher recomputes variant fingerprints, tags are not fingerprint inputs,
 * so the update lands as a no-op and never tags again. Belt and braces:
 * we also read current tags first and never rewrite an already-correct tag
 * set (a write only happens on an actual difference).
 */

export const AUTOTAG_TAG = "shelfcheck-fix";

/** Cap per run: a free-tier process must finish tagging within the drain budget. */
export const AUTOTAG_MAX_PRODUCTS_PER_RUN = 50;

const tagsQuerySchema = z.object({
  product: z.object({ id: z.string(), tags: z.array(z.string()).nullable() }).nullable(),
});

const updateMutationSchema = z.object({
  productUpdate: z
    .object({
      product: z.object({ id: z.string(), tags: z.array(z.string()).nullable() }).nullable(),
      userErrors: z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() })),
    })
    .nullable(),
});

const PRODUCT_TAGS_QUERY = /* GraphQL */ `
  query ShelfCheckProductTags($id: ID!) {
    product(id: $id) {
      id
      tags
    }
  }
`;

const PRODUCT_UPDATE_TAGS_MUTATION = /* GraphQL */ `
  mutation ShelfCheckProductUpdateTags($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        tags
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface AutoTagOutcome {
  skipped?: "disabled" | "not-pro" | "missing-scope" | "nothing-to-tag";
  tagged: number;
  untagged: number;
  errors: number;
}

/** Gate: is auto-tag allowed for this shop row right now? Null means allowed. */
export function autoTagAllowed(shop: {
  plan: string;
  scopes: string | null;
  settings: unknown;
}): "disabled" | "not-pro" | "missing-scope" | null {
  const settings = (shop.settings ?? {}) as Record<string, unknown>;
  if (settings.autoTag !== true) return "disabled";
  if (!featureEnabled(shop.plan, "autoTag")) return "not-pro";
  const scopes = (shop.scopes ?? "").split(",").map((s) => s.trim());
  if (!scopes.includes("write_products")) return "missing-scope";
  return null;
}

/**
 * Read a product's tags (isolated so an API-shape correction is one line).
 * Returns null when the product cannot be read.
 */
export async function readProductTags(
  executor: AdminGraphQLExecutor,
  productGid: string,
): Promise<string[] | null> {
  try {
    const response = await adminGraphQL(executor, PRODUCT_TAGS_QUERY, { id: productGid });
    const data = unwrapData(response, (d) => tagsQuerySchema.parse(d));
    return data.product?.tags ?? null;
  } catch (error) {
    logger.debug({ err: error, productGid }, "product tags read failed");
    return null;
  }
}

/** Add AUTOTAG_TAG to a product. Returns the new tag set, or null on failure. */
export async function addFixTag(
  executor: AdminGraphQLExecutor,
  productGid: string,
): Promise<string[] | null> {
  const current = await readProductTags(executor, productGid);
  if (current == null) return null;
  if (current.includes(AUTOTAG_TAG)) return current; // already tagged: NO write
  const tags = [...current, AUTOTAG_TAG];
  try {
    const response = await adminGraphQL(executor, PRODUCT_UPDATE_TAGS_MUTATION, {
      product: { id: productGid, tags },
    });
    const data = unwrapData(response, (d) => updateMutationSchema.parse(d));
    if (!data.productUpdate || data.productUpdate.userErrors.length > 0) return null;
    return data.productUpdate.product?.tags ?? tags;
  } catch (error) {
    logger.warn({ err: error, productGid }, "productUpdate(tags) failed");
    return null;
  }
}

/** Remove AUTOTAG_TAG from a product (issues fixed or feature turned off). */
export async function removeFixTag(
  executor: AdminGraphQLExecutor,
  productGid: string,
): Promise<string[] | null> {
  const current = await readProductTags(executor, productGid);
  if (current == null) return null;
  if (!current.includes(AUTOTAG_TAG)) return current; // already untagged: NO write
  const tags = current.filter((t) => t !== AUTOTAG_TAG);
  try {
    const response = await adminGraphQL(executor, PRODUCT_UPDATE_TAGS_MUTATION, {
      product: { id: productGid, tags },
    });
    const data = unwrapData(response, (d) => updateMutationSchema.parse(d));
    if (!data.productUpdate || data.productUpdate.userErrors.length > 0) return null;
    return data.productUpdate.product?.tags ?? tags;
  } catch (error) {
    logger.warn({ err: error, productGid }, "productUpdate(tags) remove failed");
    return null;
  }
}

/**
 * Tag products with open issues; untag products whose issues are all gone.
 * One bounded run; called from the scan-complete path only (never directly
 * from webhook processing — the fingerprint check there is the loop guard).
 */
export async function applyAutoTags(
  params: {
    shopId: string;
    executor: AdminGraphQLExecutor;
    client: PrismaClient;
    log?: Logger;
  },
): Promise<AutoTagOutcome> {
  const { shopId, executor, client } = params;
  const log = params.log ?? logger;
  const outcome: AutoTagOutcome = { tagged: 0, untagged: 0, errors: 0 };

  const shop = await client.shop.findUnique({ where: { id: shopId } });
  if (!shop) return { ...outcome, skipped: "nothing-to-tag" };
  const gate = autoTagAllowed(shop);
  if (gate) return { ...outcome, skipped: gate };

  // Products with at least one open issue → ensure tagged.
  const openRows = await client.issue.findMany({
    where: { shopId, status: "open", productGid: { not: null } },
    select: { productGid: true },
    take: 500,
  });
  const withIssues = [...new Set(openRows.map((r) => r.productGid).filter((g): g is string => g != null))];

  // Products previously tagged whose issues are all resolved/absent → untag.
  const settings = (shop.settings ?? {}) as Record<string, unknown>;
  const knownTagged = Array.isArray(settings.autoTaggedProducts)
    ? (settings.autoTaggedProducts as unknown[]).filter((g): g is string => typeof g === "string")
    : [];
  const stillOpen = new Set(withIssues);
  const toUntag = knownTagged.filter((g) => !stillOpen.has(g));

  for (const gid of withIssues.slice(0, AUTOTAG_MAX_PRODUCTS_PER_RUN)) {
    const result = await addFixTag(executor, gid);
    if (result == null) outcome.errors += 1;
    else if (result.includes(AUTOTAG_TAG)) outcome.tagged += 1;
  }
  for (const gid of toUntag.slice(0, AUTOTAG_MAX_PRODUCTS_PER_RUN)) {
    const result = await removeFixTag(executor, gid);
    if (result == null) outcome.errors += 1;
    else if (!result.includes(AUTOTAG_TAG)) outcome.untagged += 1;
  }

  // Record what is tagged now (bounded list) so the next run can untag.
  const taggedNow = withIssues.slice(0, AUTOTAG_MAX_PRODUCTS_PER_RUN);
  if (JSON.stringify(taggedNow) !== JSON.stringify(knownTagged.slice(0, AUTOTAG_MAX_PRODUCTS_PER_RUN))) {
    await client.shop.update({
      where: { id: shopId },
      data: { settings: { ...settings, autoTaggedProducts: taggedNow } as never },
    });
  }

  if (withIssues.length === 0 && toUntag.length === 0) {
    return { ...outcome, skipped: "nothing-to-tag" };
  }
  log.info({ shopId, ...outcome }, "auto-tag run complete");
  return outcome;
}
