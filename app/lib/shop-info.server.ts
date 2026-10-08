import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { adminGraphQL, unwrapData, type AdminGraphQLExecutor } from "./admin-graphql.server.js";

/**
 * Shop info fetch + persist. The ONLY place that knows the `shop` query
 * fields (docs/api-notes.md §5): ianaTimezone is documented; currencyCode's
 * exact path under 2026-07 is [LIVE]-pending, so the whole query is isolated
 * here and validated with zod — a schema change is a one-file fix.
 */

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShelfCheckShopInfo {
    shop {
      ianaTimezone
      currencyCode
      myshopifyDomain
      name
    }
  }
`;

const responseSchema = z.object({
  shop: z.object({
    ianaTimezone: z.string().nullable().optional(),
    currencyCode: z.string().nullable().optional(),
    myshopifyDomain: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  }),
});

export interface ShopInfo {
  timezone: string | null;
  currency: string | null;
  myshopifyDomain: string | null;
  name: string | null;
}

/** The admin handle used in https://admin.shopify.com/store/<handle>/ links. */
export function handleFromDomain(myshopifyDomain: string | null, shopDomain: string): string {
  const domain = myshopifyDomain ?? shopDomain;
  return domain.replace(/\.myshopify\.com$/, "");
}

export async function fetchShopInfo(executor: AdminGraphQLExecutor): Promise<ShopInfo> {
  const response = await adminGraphQL(executor, SHOP_INFO_QUERY, undefined, {});
  const data = unwrapData(response, (d) => responseSchema.parse(d));
  return {
    timezone: data.shop.ianaTimezone ?? null,
    currency: data.shop.currencyCode ?? null,
    myshopifyDomain: data.shop.myshopifyDomain ?? null,
    name: data.shop.name ?? null,
  };
}

/** Fetch and store time zone, currency, and handle on the shops row. */
export async function updateShopInfo(
  shopId: string,
  shopDomain: string,
  executor: AdminGraphQLExecutor,
  client: PrismaClient = db,
): Promise<void> {
  const info = await fetchShopInfo(executor);
  await client.shop.update({
    where: { id: shopId },
    data: {
      timezone: info.timezone,
      currency: info.currency,
      shopHandle: handleFromDomain(info.myshopifyDomain, shopDomain),
    },
  });
}
