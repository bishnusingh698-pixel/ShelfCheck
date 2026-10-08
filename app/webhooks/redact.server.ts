import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { logger } from "../lib/logger.server.js";
import type { StoredWebhookEvent } from "./intake.server.js";

/**
 * GDPR compliance topics (spec <webhooks>):
 *  - shop/redact: delete EVERY row for the shop in every table, in one
 *    transaction. The shops row cascades to scans, variants, issues, rules,
 *    jobs, notifications, telegram tokens; sessions and webhook events are
 *    keyed by shop domain and removed explicitly.
 *  - customers/data_request, customers/redact: the app stores NO customer
 *    data; the event is logged (already stored, scrubbed to {shop_domain} by
 *    the intake) and acknowledged.
 *
 * RateLimitBucket rows are time-windowed counters keyed by opaque strings
 * (pruned after 24 h by the tick) and hold no shop data; they are out of
 * scope for redaction (DECISIONS.md).
 */

/** shop/redact: remove every trace of the shop. Idempotent; safe to replay. */
export async function redactShop(shopDomain: string, client: PrismaClient = db): Promise<void> {
  await client.$transaction(async (tx) => {
    const sessions = await tx.session.deleteMany({ where: { shop: shopDomain } });
    const events = await tx.webhookEvent.deleteMany({ where: { shopDomain } });
    let scans = 0;
    let variants = 0;
    let issues = 0;
    const shop = await tx.shop.findUnique({ where: { shopDomain } });
    if (shop) {
      scans = await tx.scan.count({ where: { shopId: shop.id } });
      variants = await tx.variantIndex.count({ where: { shopId: shop.id } });
      issues = await tx.issue.count({ where: { shopId: shop.id } });
      await tx.shop.delete({ where: { id: shop.id } }); // cascades the rest
    }
    logger.info(
      { shopDomain, sessions: sessions.count, events: events.count, scans, variants, issues },
      "shop/redact complete",
    );
  });
}

/** customers/data_request + customers/redact: nothing to export or erase. */
export async function acknowledgeCustomerTopic(event: StoredWebhookEvent): Promise<void> {
  logger.info(
    { topic: event.topic, shopDomain: event.shopDomain, eventId: event.id },
    "customer compliance topic acknowledged; no customer data is stored",
  );
}
