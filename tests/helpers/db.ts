import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Integration test helpers: DB reset, factories.
 * The database is reset via TRUNCATE ... CASCADE for speed; migrations are
 * tested separately (up/down/up) against a scratch database.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://openhands:openhands@127.0.0.1:5432/shelfcheck_test?connection_limit=5";

let client: PrismaClient | null = null;

export function testDb(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  }
  return client;
}

const TABLES = [
  "RateLimitBucket",
  "TelegramLinkToken",
  "NotificationLog",
  "WebhookEvent",
  "Job",
  "IgnoreRule",
  "Issue",
  "VariantIndex",
  "Scan",
  "Session",
  "Shop",
];

export async function resetDb(): Promise<void> {
  const db = testDb();
  for (const table of TABLES) {
    await db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
  }
}

export async function disposeTestDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

/** Factory: a shop row for tests. */
export async function createShop(
  overrides: Partial<{
    shopDomain: string;
    plan: string;
    timezone: string;
    currency: string;
    uiLocale: string;
    notifyLocale: string;
    settings: Record<string, unknown>;
    lastScanAt: Date;
    uninstalledAt: Date;
    shopHandle: string;
  }> = {},
) {
  const db = testDb();
  const n = Math.floor(Math.random() * 1_000_000_000);
  return db.shop.create({
    data: {
      shopDomain: overrides.shopDomain ?? `test-${n}.myshopify.com`,
      plan: overrides.plan ?? "free",
      timezone: overrides.timezone ?? "UTC",
      currency: overrides.currency ?? "USD",
      uiLocale: overrides.uiLocale ?? "en",
      notifyLocale: overrides.notifyLocale ?? "en",
      shopHandle: overrides.shopHandle ?? `test-${n}`,
      settings: (overrides.settings ?? {}) as never,
      lastScanAt: overrides.lastScanAt ?? null,
      uninstalledAt: overrides.uninstalledAt ?? null,
    },
  });
}

export async function createVariant(
  shopId: string,
  overrides: Partial<{
    variantGid: string;
    productGid: string;
    skuRaw: string | null;
    skuNorm: string | null;
    barcode: string | null;
    productStatus: string | null;
    isGiftCard: boolean;
    tracked: boolean;
    inventoryPolicy: string | null;
    inventoryQty: number | null;
    publishedAnyChannel: boolean;
    hasImage: boolean;
    requiresShipping: boolean;
    weightPresent: boolean;
    costPresent: boolean;
    variantCountOnProduct: number;
    price: string | null;
    compareAtPrice: string | null;
    seenScanId: string | null;
    fingerprint: string | null;
    vendor: string | null;
    inventoryItemId: string | null;
    productTitle: string | null;
    variantTitle: string | null;
  }> = {},
) {
  const db = testDb();
  const n = Math.floor(Math.random() * 1_000_000_000);
  return db.variantIndex.create({
    data: {
      shopId,
      variantGid: overrides.variantGid ?? `gid://shopify/ProductVariant/${n}`,
      productGid: overrides.productGid ?? `gid://shopify/Product/${n}`,
      inventoryItemId: overrides.inventoryItemId ?? `${n}`,
      productTitle: overrides.productTitle ?? "Test product",
      variantTitle: overrides.variantTitle ?? "Default",
      vendor: overrides.vendor ?? null,
      skuRaw: overrides.skuRaw ?? null,
      skuNorm: overrides.skuNorm ?? null,
      barcode: overrides.barcode ?? null,
      price: overrides.price ?? null,
      compareAtPrice: overrides.compareAtPrice ?? null,
      productStatus: overrides.productStatus ?? "ACTIVE",
      isGiftCard: overrides.isGiftCard ?? false,
      requiresShipping: overrides.requiresShipping ?? true,
      weightPresent: overrides.weightPresent ?? false,
      costPresent: overrides.costPresent ?? false,
      hasImage: overrides.hasImage ?? false,
      variantCountOnProduct: overrides.variantCountOnProduct ?? 1,
      tracked: overrides.tracked ?? false,
      inventoryPolicy: overrides.inventoryPolicy ?? null,
      inventoryQty: overrides.inventoryQty ?? null,
      publishedAnyChannel: overrides.publishedAnyChannel ?? false,
      seenScanId: overrides.seenScanId ?? null,
      fingerprint: overrides.fingerprint ?? null,
    },
  });
}

/** Factory: a scan row for tests. */
export async function createScan(
  shopId: string,
  overrides: Partial<{
    status: string;
    trigger: string;
    bulkOperationId: string | null;
    attempt: number;
    startedAt: Date;
    finishedAt: Date;
  }> = {},
) {
  const db = testDb();
  return db.scan.create({
    data: {
      shopId,
      status: (overrides.status ?? "queued") as never,
      trigger: (overrides.trigger ?? "manual") as never,
      bulkOperationId: overrides.bulkOperationId ?? null,
      attempt: overrides.attempt ?? 0,
      startedAt: overrides.startedAt ?? null,
      finishedAt: overrides.finishedAt ?? null,
    },
  });
}

/** Sign a Shopify webhook body the way Shopify does. */
export function signWebhook(rawBody: Buffer | string, secret: string): string {
  return execFileSync(
    process.execPath,
    ["-e", `const c=require('node:crypto');process.stdout.write(c.createHmac('sha256',process.argv[1]).update(process.argv[2]).digest('base64'))`, secret, rawBody.toString()],
  ).toString();
}

/** Fixed clock for tests. */
export class FakeClock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = date;
  }
}
