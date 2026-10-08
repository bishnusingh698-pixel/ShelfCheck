import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { adminGraphQL, unwrapData, type AdminGraphQLExecutor } from "../lib/admin-graphql.server.js";
import type { PlanId } from "./plans.js";

/**
 * Managed Pricing read path (spec <plans_and_limits> + docs/api-notes.md §8):
 * plans live in the Partner Dashboard; the app READS
 * currentAppInstallation.activeSubscriptions and maps the subscription NAME to
 * a plan handle. The shops row is the 5-minute cache (planCheckedAt);
 * app_subscriptions/update refreshes it immediately.
 *
 * Never trust client-side plan claims: every gate reads the shops row, which
 * only this module writes.
 */

export const ACTIVE_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query ShelfCheckActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions(first: 10) {
        nodes {
          name
          status
        }
      }
    }
  }
`;

const responseSchema = z.object({
  currentAppInstallation: z
    .object({
      activeSubscriptions: z.object({
        nodes: z.array(
          z.object({
            name: z.string(),
            status: z.string(),
          }),
        ),
      }),
    })
    .nullable(),
});

export interface SubscriptionInfo {
  name: string;
  status: string;
}

export const PLAN_CACHE_TTL_MS = 5 * 60_000;

export async function fetchActiveSubscriptions(
  executor: AdminGraphQLExecutor,
): Promise<SubscriptionInfo[]> {
  const response = await adminGraphQL(executor, ACTIVE_SUBSCRIPTIONS_QUERY, undefined, {});
  const data = unwrapData(response, (d) => responseSchema.parse(d));
  return data.currentAppInstallation?.activeSubscriptions.nodes ?? [];
}

const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, pro: 2 };

/**
 * Map subscription names to the effective plan: the highest-ranked ACTIVE
 * subscription wins (a pending downgrade must not grant features early, and a
 * lapsed higher plan must fall back). Unknown names fall back to free.
 */
export function mapSubscriptionsToPlan(subscriptions: SubscriptionInfo[]): PlanId {
  let best: PlanId = "free";
  for (const sub of subscriptions) {
    if (sub.status !== "ACTIVE") continue;
    const name = sub.name.trim().toLowerCase();
    if (name !== "starter" && name !== "pro") continue;
    if (PLAN_RANK[name] > PLAN_RANK[best]) best = name;
  }
  return best;
}

/** Refresh and store the shop's plan from Shopify. Callers own error policy. */
export async function refreshShopPlan(
  shopId: string,
  executor: AdminGraphQLExecutor,
  client: PrismaClient = db,
  now = new Date(),
): Promise<PlanId> {
  const subscriptions = await fetchActiveSubscriptions(executor);
  const plan = mapSubscriptionsToPlan(subscriptions);
  const active = subscriptions.find((s) => s.status === "ACTIVE" && s.name.toLowerCase() === plan);
  await client.shop.update({
    where: { id: shopId },
    data: {
      plan,
      planStatus: active?.status ?? (plan === "free" ? null : active?.status ?? null),
      planCheckedAt: now,
    },
  });
  return plan;
}

/**
 * Current plan with a 5-minute cache: returns the stored plan when fresh;
 * refreshes when stale AND an executor is available (loaders pass one;
 * background paths without tokens just read the cached value).
 */
export async function currentPlan(
  shopId: string,
  options: { executor?: AdminGraphQLExecutor; client?: PrismaClient; now?: Date } = {},
): Promise<PlanId> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const shop = await client.shop.findUnique({
    where: { id: shopId },
    select: { plan: true, planCheckedAt: true, uninstalledAt: true },
  });
  if (!shop) return "free";
  const stale =
    shop.planCheckedAt == null || now.getTime() - shop.planCheckedAt.getTime() > PLAN_CACHE_TTL_MS;
  if (!stale || !options.executor) return shop.plan as PlanId;
  try {
    return await refreshShopPlan(shopId, options.executor, client, now);
  } catch {
    // A failed refresh must not break the request; the stale value is the
    // safest plan available (gates stay consistent with the last known state).
    return shop.plan as PlanId;
  }
}
