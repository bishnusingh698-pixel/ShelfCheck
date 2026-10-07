import { z } from "zod";
import type { LoaderFunctionArgs } from "react-router";
import { db } from "../db.server.js";

/**
 * The ONLY source of shop_id for admin requests. Resolves the authenticated
 * session's shop and returns its `shops` row. Never trust client input for
 * shop identity or locale/timezone defaults.
 */

export const SHOP_SETTINGS_SCHEMA = z
  .object({
    enabledIssueTypes: z.array(z.string()).optional(),
    includeDraft: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    acceptNonGtinBarcodes: z.boolean().optional(),
    digest: z
      .object({
        enabled: z.boolean(),
        email: z.string().optional(),
        day: z.number().int().min(0).max(6),
        hour: z.number().int().min(0).max(23),
        skipWhenEmpty: z.boolean(),
      })
      .partial({ email: true })
      .optional(),
    telegram: z
      .object({
        chatIdEnc: z.string().optional(),
        enabled: z.boolean().optional(),
        disabledReason: z.string().optional(),
      })
      .optional(),
    autoTag: z.boolean().optional(),
  })
  .default({});

export type ShopSettings = z.infer<typeof SHOP_SETTINGS_SCHEMA>;

export interface ShopContext {
  id: string;
  shopDomain: string;
  shopHandle: string | null;
  timezone: string | null;
  currency: string | null;
  uiLocale: string | null;
  notifyLocale: string | null;
  scopes: string | null;
  plan: string;
  planStatus: string | null;
  settings: ShopSettings;
  installedAt: Date;
  uninstalledAt: Date | null;
  lastScanAt: Date | null;
  lastDigestAt: Date | null;
}

export async function loadShopContext(shopDomain: string): Promise<ShopContext | null> {
  const shop = await db.shop.findUnique({ where: { shopDomain } });
  if (!shop) return null;
  const settings = SHOP_SETTINGS_SCHEMA.parse(shop.settings ?? {});
  return {
    id: shop.id,
    shopDomain: shop.shopDomain,
    shopHandle: shop.shopHandle,
    timezone: shop.timezone,
    currency: shop.currency,
    uiLocale: shop.uiLocale,
    notifyLocale: shop.notifyLocale,
    scopes: shop.scopes,
    plan: shop.plan,
    planStatus: shop.planStatus,
    settings,
    installedAt: shop.installedAt,
    uninstalledAt: shop.uninstalledAt,
    lastScanAt: shop.lastScanAt,
    lastDigestAt: shop.lastDigestAt,
  };
}

/** Resolve shop context for an admin request given the session's shop domain. */
export async function requireShopContext(
  args: LoaderFunctionArgs,
  session: { shop: string },
): Promise<ShopContext> {
  const ctx = await loadShopContext(session.shop);
  if (!ctx) throw new Error(`shop context missing for ${session.shop}`);
  void args;
  return ctx;
}
