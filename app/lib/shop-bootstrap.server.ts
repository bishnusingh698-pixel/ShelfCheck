import type { Session } from "@shopify/shopify-api";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { db } from "../db.server.js";
import { logger } from "./logger.server.js";
import { resolveLocale } from "../i18n/resolve-locale.js";
import { SHOP_SETTINGS_SCHEMA } from "./shop-context.server.js";
import { updateShopInfo } from "./shop-info.server.js";
import { triggerScan } from "../scan/orchestrator.server.js";
import { adminContextExecutor } from "../jobs/executor.server.js";

/**
 * Install / re-auth bootstrap, called from the afterAuth hook.
 *
 *  - upserts the shops row (the ONLY writer of shop identity at auth time),
 *  - syncs time zone, currency, and admin handle from the Shop object,
 *  - defaults uiLocale to the merchant's admin locale and notifyLocale to it,
 *  - starts the INSTALL scan exactly once (never on token re-auth).
 *
 * Idempotent: afterAuth fires on install AND whenever offline tokens are
 * re-issued; every write here is either an upsert or guarded.
 */

export async function ensureShopRecord(session: Session): Promise<{ shopId: string; created: boolean }> {
  const existing = await db.shop.findUnique({ where: { shopDomain: session.shop } });
  if (existing) {
    await db.shop.update({
      where: { id: existing.id },
      data: {
        scopes: session.scope ?? existing.scopes,
        // Reinstall after uninstall: the shop is active again.
        uninstalledAt: null,
      },
    });
    return { shopId: existing.id, created: false };
  }
  const locale = resolveLocale(session.onlineAccessInfo?.associated_user?.locale);
  const created = await db.shop.create({
    data: {
      shopDomain: session.shop,
      scopes: session.scope ?? null,
      plan: "free",
      uiLocale: locale,
      notifyLocale: locale,
      settings: SHOP_SETTINGS_SCHEMA.parse({}) as never,
    },
  });
  return { shopId: created.id, created: true };
}

/** afterAuth hook: bootstrap the shop and start the first scan once. */
export async function bootstrapAfterAuth(session: Session, admin: AdminApiContext): Promise<void> {
  const { shopId } = await ensureShopRecord(session);

  try {
    await updateShopInfo(shopId, session.shop, adminContextExecutor(admin));
  } catch (error) {
    // Shop info is an optimization (digest/scheduler defaults, admin links);
    // failing the auth flow over it would block the merchant entirely.
    logger.warn({ err: error, shopId }, "shop info refresh failed after auth");
  }

  const scanCount = await db.scan.count({ where: { shopId } });
  if (scanCount === 0) {
    try {
      await triggerScan({ shopId, trigger: "install", client: db, logger });
      logger.info({ shopId }, "install scan triggered");
    } catch (error) {
      logger.error({ err: error, shopId }, "install scan trigger failed");
    }
  }
}
