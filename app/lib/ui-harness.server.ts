import type { PrismaClient } from "@prisma/client";
import { getEnv } from "../env.server.js";
import { logger } from "./logger.server.js";

/**
 * Test-only fixture shop context for Playwright (spec <file_layout>:
 * app/lib/ui-harness.server.ts). INERT unless NODE_ENV=test AND UI_HARNESS=1
 * — env.server.ts throws if UI_HARNESS leaks into production, and every entry
 * point here re-checks both flags before doing anything.
 *
 * The harness lets the e2e suites exercise real routes/loaders against a
 * seeded fixture shop without a live Shopify session (no OAuth round trip,
 * no App Bridge token). The fixtures are ordinary database rows: the loaders
 * under test run their real queries against them.
 */

export const HARNESS_SHOP_DOMAIN = "ui-harness.myshopify.com";
export const HARNESS_ONBOARDING_SHOP_DOMAIN = "onboarding.ui-harness.myshopify.com";
const HARNESS_SHOP_ID = "ui-harness-shop";
const HARNESS_ONBOARDING_SHOP_ID = "ui-harness-onboarding-shop";

export function uiHarnessActive(): boolean {
  const env = getEnv();
  return env.NODE_ENV === "test" && env.UI_HARNESS === true;
}

/** A session shaped like the one authenticate.admin returns. */
export interface HarnessSession {
  session: { shop: string; id: string };
}

/**
 * Stand-in for authenticate.admin when the harness is active. The optional
 * ?fixture=onboarding param selects the fresh-install fixture shop (no
 * completed scan) so e2e can cover the onboarding branch too.
 */
export function harnessSession(request?: Request): HarnessSession | null {
  if (!uiHarnessActive()) return null;
  const fixture = request ? new URL(request.url).searchParams.get("fixture") : null;
  const shop = fixture === "onboarding" ? HARNESS_ONBOARDING_SHOP_DOMAIN : HARNESS_SHOP_DOMAIN;
  return { session: { shop, id: `offline_${shop}` } };
}

/**
 * Seed (idempotently) the fixture shops:
 *  - the main one with completed scans, aggregate counts, and open issues,
 *  - an onboarding one that has only just installed (first scan queued).
 * Called by the harness boot path only.
 */
export async function seedUiHarnessFixture(client: PrismaClient): Promise<void> {
  if (!uiHarnessActive()) return;

  const existing = await client.shop.findUnique({ where: { id: HARNESS_SHOP_ID } });
  if (existing) return; // already seeded for this server run

  await client.shop.create({
    data: {
      id: HARNESS_SHOP_ID,
      shopDomain: HARNESS_SHOP_DOMAIN,
      plan: "starter",
      scopes: "read_products,read_inventory",
      settings: {},
      installedAt: new Date(),
    },
  });

  const now = Date.now();
  const opened = [3, 5, 2, 6, 1, 4, 2, 1];
  for (let i = opened.length - 1; i >= 0; i -= 1) {
    // Most recent scan finished 2 days ago: past the 10-minute cooldown and
    // outside today's manual-scan window, so the dashboard shows Scan now.
    const finishedAt = new Date(now - 2 * 86_400_000 - i * 3_600_000);
    await client.scan.create({
      data: {
        shopId: HARNESS_SHOP_ID,
        trigger: "scheduled",
        status: "completed",
        variantsSeen: 4821,
        variantsAnalyzed: 4821,
        healthScore: 72,
        counts: {
          high: 2,
          medium: 2,
          low: 1,
          byType: { MISSING_SKU: 2, MISSING_BARCODE: 2, MISSING_WEIGHT: 1 },
          openTotal: 5,
          openedThisScan: opened[opened.length - 1 - i],
          resolvedThisScan: Math.max(opened[opened.length - 1 - i] - 2, 0),
        } as never,
        startedAt: new Date(finishedAt.getTime() - 240_000),
        finishedAt,
        createdAt: finishedAt,
      },
    });
  }
  await client.shop.update({
    where: { id: HARNESS_SHOP_ID },
    data: { lastScanAt: new Date(now - 2 * 86_400_000) },
  });

  const fixtureIssues: Array<{
    type: string;
    severity: string;
    variantGid: string;
    productGid: string;
    productTitle: string;
    sku: string | null;
    vendor?: string | null;
    variantTitle?: string | null;
    barcode?: string | null;
    groupKey?: string;
    status?: string;
    snoozedUntil?: Date;
  }> = [
    { type: "MISSING_SKU", severity: "high", variantGid: "gid://shopify/ProductVariant/h101", productGid: "gid://shopify/Product/h1", productTitle: "Harness High Widget", sku: null, vendor: "HarnessVendor", variantTitle: "Small" },
    { type: "MISSING_SKU", severity: "high", variantGid: "gid://shopify/ProductVariant/h102", productGid: "gid://shopify/Product/h1", productTitle: "Harness High Widget", sku: null, vendor: "HarnessVendor", variantTitle: "Large" },
    { type: "MISSING_BARCODE", severity: "medium", variantGid: "gid://shopify/ProductVariant/h201", productGid: "gid://shopify/Product/h2", productTitle: "Harness Medium Widget", sku: "MW-1", vendor: "OtherVendor", variantTitle: null, barcode: null },
    { type: "MISSING_BARCODE", severity: "medium", variantGid: "gid://shopify/ProductVariant/h202", productGid: "gid://shopify/Product/h2", productTitle: "Harness Medium Widget", sku: "MW-2", vendor: "OtherVendor", variantTitle: null, barcode: null },
    { type: "MISSING_WEIGHT", severity: "low", variantGid: "gid://shopify/ProductVariant/h301", productGid: "gid://shopify/Product/h3", productTitle: "Harness Low Widget", sku: "LW-1", vendor: "HarnessVendor", variantTitle: null, barcode: "123456789012", status: "snoozed", snoozedUntil: new Date(now + 7 * 86_400_000) },
    { type: "DUPLICATE_SKU", severity: "high", variantGid: "gid://shopify/ProductVariant/h401", productGid: "gid://shopify/Product/h4", productTitle: "Harness Dup Widget A", sku: "DUP-1", vendor: "HarnessVendor", variantTitle: null, groupKey: "dup-1" },
    { type: "DUPLICATE_SKU", severity: "high", variantGid: "gid://shopify/ProductVariant/h402", productGid: "gid://shopify/Product/h5", productTitle: "Harness Dup Widget B", sku: "DUP-1", vendor: "OtherVendor", variantTitle: null, groupKey: "dup-1" },
  ];
  for (const issue of fixtureIssues) {
    await client.issue.create({
      data: {
        shopId: HARNESS_SHOP_ID,
        type: issue.type,
        severity: issue.severity,
        variantGid: issue.variantGid,
        productGid: issue.productGid,
        groupKey: issue.groupKey ?? "",
        details: {
          product_title: issue.productTitle,
          sku: issue.sku,
          vendor: issue.vendor ?? null,
          variant_title: issue.variantTitle ?? null,
          barcode: issue.barcode ?? null,
        } as never,
        status: issue.status ?? "open",
        snoozedUntil: issue.snoozedUntil ?? null,
        firstSeenScanId: "seed",
        lastSeenScanId: "seed",
      },
    });
  }

  // Fresh-install fixture: first scan queued, none completed yet.
  await client.shop.create({
    data: {
      id: HARNESS_ONBOARDING_SHOP_ID,
      shopDomain: HARNESS_ONBOARDING_SHOP_DOMAIN,
      plan: "starter",
      scopes: "read_products,read_inventory",
      settings: {},
      installedAt: new Date(),
    },
  });
  await client.scan.create({
    data: {
      shopId: HARNESS_ONBOARDING_SHOP_ID,
      trigger: "install",
      status: "queued",
    },
  });

  logger.warn({ shop: HARNESS_SHOP_DOMAIN }, "UI harness fixture seeded (test-only)");
}
