import { authenticate } from "../shopify.server";
import { harnessSession, uiHarnessActive, seedUiHarnessFixture } from "./ui-harness.server.js";
import { db } from "../db.server.js";
import { requireShopContext, type ShopContext } from "./shop-context.server.js";

/**
 * authenticate.admin with a test-only harness bypass (spec: app/lib/
 * ui-harness.server.ts is the Playwright fixture seam). Production and
 * normal tests always take the real path; only when NODE_ENV=test AND
 * UI_HARNESS=1 does this return a session bound to the seeded fixture shop
 * (seeding happens exactly once per server run, inside this module).
 *
 * Admin routes use this instead of calling authenticate.admin directly so
 * the same route code serves both the real app and the harness.
 */
export async function authenticateAdmin(
  request: Request,
): Promise<{ session: { shop: string; id: string } }> {
  if (uiHarnessActive()) {
    await seedUiHarnessFixture(db);
    const session = harnessSession(request);
    if (session) return session;
  }
  const { session } = await authenticate.admin(request);
  return { session: { shop: session.shop, id: session.id } };
}

/** authenticateAdmin + shop-context resolution in one call. */
export async function requireAdminShopContext(request: Request): Promise<ShopContext> {
  const { session } = await authenticateAdmin(request);
  return requireShopContext(session);
}
