import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";
import type { AdminGraphQLExecutor } from "../lib/admin-graphql.server.js";
import { logger } from "../lib/logger.server.js";

/**
 * Admin GraphQL executors for background work (jobs, webhooks). The library's
 * `unauthenticated.admin(shopDomain)` resolves the shop's OFFLINE session
 * (refreshing expiring tokens) and returns an admin client.
 *
 * Every job that talks to Shopify goes through here, so token/session errors
 * surface in exactly one place and can be typed uniformly.
 */

export class MissingSessionError extends Error {
  constructor(shopDomain: string) {
    super(`no offline session for ${shopDomain}`);
    this.name = "MissingSessionError";
  }
}

/** Build the admin-graphql executor shape from a library admin context. */
export function adminContextExecutor(admin: {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}): AdminGraphQLExecutor {
  return {
    graphql: async (options) => {
      const response = await admin.graphql(options.query, { variables: options.variables });
      return (await response.json()) as {
        data?: unknown;
        errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
        extensions?: Record<string, unknown>;
      };
    },
  };
}

/** Resolve an executor for a job's shop (loads the shop row → session → admin). */
export async function makeJobExecutor(shopId: string, client: PrismaClient = db): Promise<AdminGraphQLExecutor> {
  const shop = await client.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new MissingSessionError(`shop row ${shopId}`);
  return adminContextExecutorFromUnauthenticated(shop.shopDomain);
}

/** Resolve an executor straight from a shop domain via the library. */
export async function adminContextExecutorFromUnauthenticated(shopDomain: string): Promise<AdminGraphQLExecutor> {
  try {
    const { admin } = await unauthenticated.admin(shopDomain);
    return adminContextExecutor(admin);
  } catch (error) {
    if (error instanceof Error && /Could not find a session/.test(error.message)) {
      throw new MissingSessionError(shopDomain);
    }
    logger.debug({ err: error, shopDomain }, "unauthenticated admin context failed");
    throw error;
  }
}
