/**
 * Test-only Shopify credentials. Import this module FIRST, before anything
 * that (transitively) imports app/shopify.server.ts: that module evaluates
 * shopifyApp() at import time and throws on an empty appUrl. ESM evaluates
 * imports in order, so a first-position import guarantees the env is set.
 */
process.env.SHOPIFY_API_KEY ??= "test-api-key";
process.env.SHOPIFY_API_SECRET ??= "test-api-secret";
process.env.SHOPIFY_APP_URL ??= "https://app.example.dev";
process.env.SCOPES ??= "read_products,read_inventory";

export const TEST_API_KEY = process.env.SHOPIFY_API_KEY!;
export const TEST_API_SECRET = process.env.SHOPIFY_API_SECRET!;
