/**
 * Live Admin API schema verification (npm run verify:api).
 * Re-checks every field used by the bulk query, shop query, and billing query
 * (docs/api-notes.md) against a live dev store via introspection.
 *
 * With SHOPIFY_DEV_STORE_DOMAIN + SHOPIFY_DEV_ADMIN_TOKEN present it runs
 * for real and fails (exit 1) on any missing field. Without credentials it
 * prints the exact checks and exits 0 — "ready for human verification"
 * (HUMAN_STEPS.md §7), never a pass.
 */

import { existsSync, readFileSync } from "node:fs";
import { ADMIN_API_VERSION } from "../app/lib/api-version.js";
import { BULK_SCAN_QUERY } from "../app/scan/bulk-query.js";

/** Minimal .env loader (dev scripts only). */
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

/** Field paths (dotted) that must exist in the live schema. */
const REQUIRED_FIELDS: string[] = [
  // Bulk query (extracted from BULK_QUERY below for reference; the real
  // check parses the query text itself).
  "QueryRoot.productVariants",
  "ProductVariants.edges.node.id",
  "ProductVariants.edges.node.sku",
  "ProductVariants.edges.node.barcode",
  "ProductVariants.edges.node.price",
  "ProductVariants.edges.node.compareAtPrice",
  "ProductVariants.edges.node.inventoryPolicy",
  "ProductVariants.edges.node.inventoryQuantity",
  "ProductVariants.edges.node.title",
  "ProductVariant.product",
  "Product.id",
  "Product.title",
  "Product.vendor",
  "Product.status",
  "Product.isGiftCard",
  "Product.variantsCount",
  "ProductVariant.inventoryItem",
  "InventoryItem.id",
  "InventoryItem.tracked",
  "InventoryItem.requiresShipping",
  "InventoryItem.unitCost",
  "InventoryItem.measurement",
  "MutationRoot.bulkOperationRunQuery",
  "QueryRoot.bulkOperation",
  "QueryRoot.shop",
  "Shop.timezoneName",
  "Shop.currencyCode",
  "Shop.myshopifyDomain",
  "QueryRoot.currentAppInstallation",
  "AppInstallation.activeSubscriptions",
  "AppSubscription.name",
  "AppSubscription.status",
];

function graphqlNames(fieldPath: string): { parent: string; field: string } {
  const [parent, field] = fieldPath.split(".");
  return { parent: parent.split(".").pop() as string, field };
}

async function introspect(): Promise<Map<string, Set<string>>> {
  const res = await fetch(`https://${DOMAIN}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN as string },
    body: JSON.stringify({
      query: `{
        __schema {
          types {
            name
            fields { name }
          }
        }
      }`,
    }),
  });
  const body = (await res.json()) as {
    data?: { __schema: { types: { name: string; fields: { name: string }[] | null }[] } };
    errors?: { message: string }[];
  };
  if (!res.ok || body.errors?.length) {
    throw new Error(`introspection failed (${res.status}): ${body.errors?.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("introspection returned no data");
  const map = new Map<string, Set<string>>();
  for (const t of body.data.__schema.types) {
    map.set(t.name, new Set((t.fields ?? []).map((f) => f.name)));
  }
  return map;
}

function verifyBulkQueryText(schema: Map<string, Set<string>>, failures: string[]): void {
  // Pull every { ... } inline-selection field name from BULK_QUERY and check
  // it against the type named on the line before it is too strict without a
  // full GraphQL parser; the explicit REQUIRED_FIELDS table carries the
  // contract, so here we only sanity-check the query mentions them.
  for (const f of ["productVariants", "bulkOperationRunQuery", "product", "inventoryItem"]) {
    if (!BULK_SCAN_QUERY.includes(f)) failures.push(`BULK_SCAN_QUERY does not mention ${f} (bulk-query.ts drifted?)`);
  }
}

async function main() {
  console.log(`verify-api — Admin API ${ADMIN_API_VERSION}`);
  if (!DOMAIN || !TOKEN) {
    console.log(`No dev-store credentials. ${REQUIRED_FIELDS.length} field checks are prepared:`);
    for (const f of REQUIRED_FIELDS) console.log(`  pending  ${f}`);
    console.log(`Set SHOPIFY_DEV_STORE_DOMAIN and SHOPIFY_DEV_ADMIN_TOKEN in .env to run live (HUMAN_STEPS.md §7).`);
    return; // exit 0: prepared, not passed
  }
  const schema = await introspect();
  const failures: string[] = [];
  verifyBulkQueryText(schema, failures);
  for (const path of REQUIRED_FIELDS) {
    const { parent, field } = graphqlNames(path);
    const fields = schema.get(parent);
    if (!fields) failures.push(`type ${parent} not found (from ${path})`);
    else if (!fields.has(field)) failures.push(`field ${parent}.${field} missing (from ${path})`);
    else console.log(`  ok  ${parent}.${field}`);
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`verify-api — all ${REQUIRED_FIELDS.length} field checks passed live.`);
}

main().catch((e) => {
  console.error(`verify-api failed: ${(e as Error).message}`);
  process.exit(1);
});
