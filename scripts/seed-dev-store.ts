/**
 * Creates the seed catalog (scripts/seed-catalog.ts) on a DEV STORE so the
 * live dashboard counts can be compared against EXPECTED_ISSUES.
 * Run: npm run seed:dev-store
 *
 * Dev-only credentials in .env (never production):
 *   SHOPIFY_DEV_STORE_DOMAIN  e.g. shelfcheck-dev.myshopify.com
 *   SHOPIFY_DEV_ADMIN_TOKEN   custom-app Admin API access token
 *
 * Verified mutations (docs/api-notes.md §16, shopify.dev quotes):
 *   productCreate — "only supports creating a product with its initial
 *     product variant. To create multiple product variants for a single
 *     product and manage prices, use the productVariantsBulkCreate mutation."
 *   productVariantsBulkCreate(productId, strategy, variants) — strategy
 *     "defines which behavior the mutation should observe, such as whether
 *     to keep or delete the standalone variant".
 *
 * Without credentials this prints the exact manual steps and exits 1 — the
 * live result is always reported as "ready for human verification".
 */

import { existsSync, readFileSync } from "node:fs";
import { SEED_CATALOG, EXPECTED_ISSUES, EXPECTED_TOTAL, seedVariantCount } from "./seed-catalog.js";
import { ADMIN_API_VERSION } from "../app/lib/api-version.js";

/** Minimal .env loader (dev scripts only; no dotenv dependency). */
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const DOMAIN = process.env.SHOPIFY_DEV_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_DEV_ADMIN_TOKEN;

if (!DOMAIN || !TOKEN) {
  console.error(`seed-dev-store: dev-store credentials missing.

Manual steps (HUMAN_STEPS.md §live-seed):
 1. Dev store admin → Settings → Apps and sales channels → Develop apps →
    create "ShelfCheck fixtures" with read_products + write_products, copy the
    Admin API access token.
 2. .env:
      SHOPIFY_DEV_STORE_DOMAIN=<store>.myshopify.com
      SHOPIFY_DEV_ADMIN_TOKEN=shpat_…
 3. npm run seed:dev-store
 4. Expected: ${SEED_CATALOG.length} products / ${seedVariantCount} variants created.
 5. Install ShelfCheck; the install scan must open exactly ${EXPECTED_TOTAL} issues:
    ${Object.entries(EXPECTED_ISSUES).map(([t, c]) => `${t}=${c}`).join(", ")}
`);
  process.exit(1);
}

const ENDPOINT = `https://${DOMAIN}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN as string },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) {
    throw new Error(`GraphQL ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? res.statusText}`);
  }
  return body.data as T;
}

const LOCATION_QUERY = `
  { shop { primaryLocation { id } } }
`;

const PRODUCT_CREATE = `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_CREATE = `
  mutation productVariantsBulkCreate($productId: ID!, $strategy: ProductVariantsBulkCreateStrategy, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, strategy: $strategy, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

async function main() {
  const { shop } = await gql<{ shop: { primaryLocation: { id: string } | null } }>(LOCATION_QUERY, {});
  const locationId = shop.primaryLocation?.id;
  if (!locationId) throw new Error("no primary location on the dev store (inventory fixtures need one)");
  console.log(`Seeding ${SEED_CATALOG.length} products / ${seedVariantCount} variants on ${DOMAIN}…`);

  for (const p of SEED_CATALOG) {
    const created = await gql<{ productCreate: { product: { id: string }; userErrors: { message: string }[] } }>(
      PRODUCT_CREATE,
      { input: { title: p.title, vendor: p.vendor, status: p.status, tags: ["shelfcheck-fixture"] } },
    );
    if (created.productCreate.userErrors.length) {
      throw new Error(`productCreate ${p.title}: ${created.productCreate.userErrors.map((e) => e.message).join("; ")}`);
    }
    const productId = created.productCreate.product.id;

    const variants = p.variants.map((v) => ({
      optionValues: [{ optionName: "Fixture", name: v.title }],
      price: v.price,
      compareAtPrice: v.compareAtPrice ?? undefined,
      barcode: v.barcode ?? undefined,
      inventoryPolicy: v.inventoryPolicy,
      // "The inventory item associated with the variant, used for unit cost."
      inventoryItem: {
        sku: v.sku ?? undefined,
        cost: v.unitCost ?? undefined,
        tracked: v.tracked,
        requiresShipping: v.requiresShipping,
      },
      inventoryQuantities:
        v.inventoryQuantity == null
          ? undefined
          : [{ locationId, quantity: v.inventoryQuantity, availableQuantity: v.inventoryQuantity }],
    }));
    const bulk = await gql<{
      productVariantsBulkCreate: { productVariants: { id: string }[]; userErrors: { message: string }[] };
    }>(VARIANTS_BULK_CREATE, {
      // "whether to keep or delete the standalone variant (when product has
      // only a single or default variant) when creating new variants in bulk"
      productId,
      strategy: "REMOVE_STANDALONE",
      variants,
    });
    if (bulk.productVariantsBulkCreate.userErrors.length) {
      throw new Error(
        `productVariantsBulkCreate ${p.title}: ${bulk.productVariantsBulkCreate.userErrors.map((e) => e.message).join("; ")}`,
      );
    }
    console.log(`  ${p.title}: ${bulk.productVariantsBulkCreate.productVariants.length} variants`);
  }
  console.log(`Done. Expected after the install scan: exactly ${EXPECTED_TOTAL} open issues.`);
}

main().catch((e) => {
  console.error(`seed-dev-store failed: ${(e as Error).message}`);
  process.exit(1);
});
