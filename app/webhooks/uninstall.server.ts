import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { logger } from "../lib/logger.server.js";

/**
 * app/uninstalled (spec <webhooks> "Specific behavior"):
 *  - mark uninstalled,
 *  - delete the access tokens (sessions) immediately,
 *  - cancel pending jobs,
 *  - stop notifications (digest selection and telegram alerts check
 *    uninstalledAt before sending — enforced there, so nothing here races).
 *
 * Catalog data (variant_index, issues, scans) is KEPT until shop/redact
 * (recorded in DECISIONS.md): a reinstall restores history after a fresh scan
 * instead of silently losing the merchant's audit trail.
 *
 * All writes are idempotent so the webhook route (which deletes sessions
 * synchronously before returning 200) and the async job can both run.
 */

export async function uninstallShop(shopDomain: string, client: PrismaClient = db): Promise<void> {
  const now = new Date();
  const shop = await client.shop.findUnique({ where: { shopDomain } });

  // Tokens first, always — even if the shops row is missing.
  const sessions = await client.session.deleteMany({ where: { shop: shopDomain } });

  if (!shop) {
    logger.info({ shopDomain, sessions: sessions.count }, "uninstall for unknown shop; sessions deleted");
    return;
  }

  const jobs = await client.job.deleteMany({
    where: { shopId: shop.id, status: "pending" },
  });

  // Telegram link tokens are dead on uninstall (they grant nothing else).
  await client.telegramLinkToken.deleteMany({ where: { shopId: shop.id } });

  const updated = await client.shop.updateMany({
    where: { id: shop.id, uninstalledAt: null },
    data: { uninstalledAt: now },
  });

  logger.info(
    { shopId: shop.id, shopDomain, sessions: sessions.count, jobsCanceled: jobs.count, firstUninstall: updated.count === 1 },
    "shop uninstalled",
  );
}
