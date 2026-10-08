import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { intakeWebhook } from "../webhooks/intake.server.js";
import { uninstallShop } from "../webhooks/uninstall.server.js";
import { db } from "../db.server.js";

/**
 * app/uninstalled. HMAC is verified by authenticate.webhook on the raw body.
 * The token/session deletion runs synchronously (spec: "immediately") before
 * the 200; the rest (uninstalledAt, job cancellation) is idempotent in the
 * async webhook_process job.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await intakeWebhook({ topic, shopDomain: shop, webhookId, payload });

  // Tokens must not outlive the uninstall even if no worker ever runs again.
  await db.session.deleteMany({ where: { shop } });
  await uninstallShop(shop);

  return new Response();
};
