import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { intakeWebhook } from "../webhooks/intake.server.js";

/**
 * products/create, products/update, products/delete.
 * HMAC is verified by authenticate.webhook on the raw body; the intake
 * dedupes on X-Shopify-Webhook-Id, persists, and enqueues the async job.
 * The processor debounces per product (~30 s) and re-runs targeted detection.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await intakeWebhook({ topic, shopDomain: shop, webhookId, payload });

  return new Response();
};
