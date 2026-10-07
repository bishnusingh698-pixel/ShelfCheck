/**
 * Generates JSONL fixtures from seed-catalog.ts:
 *  - tests/fixtures/seed-catalog.jsonl  (small, committed)
 *  - tests/fixtures/large-50k.jsonl    (50,000 variants, NOT committed; generated
 *    by gen:fixtures and used for the memory integration test)
 *
 * Output follows the verified bulk-operation JSONL shape (docs/api-notes.md §3):
 * variant lines carry inlined plain-object children (product, inventoryItem);
 * media edges come as separate __parentId lines right after their variant.
 */

import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { SEED_CATALOG, seedVariantCount } from "./seed-catalog.js";

const FIXTURES_DIR = "tests/fixtures";
const SEED_FILE = `${FIXTURES_DIR}/seed-catalog.jsonl`;
const LARGE_FILE = `${FIXTURES_DIR}/large-50k.jsonl`;
const LARGE_COUNT = 50_000;

function variantGid(id: number) {
  return `gid://shopify/ProductVariant/${id}`;
}
function productGid(id: number) {
  return `gid://shopify/Product/${id}`;
}
function inventoryItemGid(id: number) {
  return `gid://shopify/InventoryItem/${900000 + id}`;
}
function mediaGid(id: number) {
  return `gid://shopify/MediaImage/${800000 + id}`;
}

function seedVariantLines(): string[] {
  const lines: string[] = [];
  for (const product of SEED_CATALOG) {
    for (const v of product.variants) {
      lines.push(
        JSON.stringify({
          id: variantGid(v.id),
          title: v.title,
          sku: v.sku,
          barcode: v.barcode,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          inventoryPolicy: v.inventoryPolicy,
          inventoryQuantity: v.inventoryQuantity,
          product: {
            id: productGid(product.id),
            title: product.title,
            vendor: product.vendor,
            status: product.status,
            isGiftCard: product.isGiftCard,
            variantsCount: { count: product.variants.length, precision: "EXACT" },
            availablePublicationsCount: { count: v.publishedCount ?? 0, precision: "EXACT" },
          },
          inventoryItem: {
            id: inventoryItemGid(v.id),
            tracked: v.tracked,
            requiresShipping: v.requiresShipping,
            unitCost: v.unitCost == null ? null : { amount: v.unitCost, currencyCode: "USD" },
            measurement:
              v.weightValue == null
                ? { weight: null }
                : { weight: { value: v.weightValue, unit: "KILOGRAMS" } },
          },
        }),
      );
      if (v.hasMedia) {
        lines.push(JSON.stringify({ __parentId: variantGid(v.id), id: mediaGid(v.id) }));
      }
    }
  }
  return lines;
}

/** Deterministic large catalog: distinct SKUs, valid EAN-13s, occasional issues. */
function largeVariantLine(index: number): string {
  const productIdx = Math.floor(index / 3);
  const v = {
    id: 1_000_000 + index,
    title: `Variant ${index}`,
    sku: `SKU-${index.toString().padStart(6, "0")}`,
    barcode: ean13For(index),
    price: "10.00",
    compareAtPrice: null,
    inventoryPolicy: "DENY",
    inventoryQuantity: 5,
  };
  return JSON.stringify({
    id: variantGid(v.id),
    title: v.title,
    sku: v.sku,
    barcode: v.barcode,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    inventoryPolicy: v.inventoryPolicy,
    inventoryQuantity: v.inventoryQuantity,
    product: {
      id: productGid(2_000_000 + productIdx),
      title: `Product ${productIdx}`,
      vendor: "Bulk Vendor",
      status: "ACTIVE",
      isGiftCard: false,
      variantsCount: { count: 3, precision: "EXACT" },
      availablePublicationsCount: { count: 1, precision: "EXACT" },
    },
    inventoryItem: {
      id: inventoryItemGid(v.id),
      tracked: true,
      requiresShipping: true,
      unitCost: { amount: "4.00", currencyCode: "USD" },
      measurement: { weight: { value: 0.5, unit: "KILOGRAMS" } },
    },
  });
}

/** Valid EAN-13 from an index: 12 data digits + correct check digit. */
function ean13For(index: number): string {
  const base = (5_400_000_000_000n + BigInt(index)).toString().padStart(12, "0");
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return base + String((10 - (sum % 10)) % 10);
}

function main() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const seedLines = seedVariantLines();
  writeFileSync(SEED_FILE, seedLines.join("\n") + "\n", "utf8");
  console.log(`${SEED_FILE}: ${seedVariantCount} variants, ${seedLines.length} lines`);

  // Large file: clean 50k variants (memory test measures peak RSS; malformed
  // lines are covered by the committed malformed.jsonl fixture).
  const stream = createWriteStream(LARGE_FILE, { encoding: "utf8" });
  for (let i = 0; i < LARGE_COUNT; i++) {
    stream.write(largeVariantLine(i) + "\n");
  }
  stream.end(() => console.log(`${LARGE_FILE}: ${LARGE_COUNT} variants`));
}

main();
