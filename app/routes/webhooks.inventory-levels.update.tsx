import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { intakeWebhook } from "../webhooks/intake.server.js";

/**
 * inventory_levels/update. The payload carries an inventory_item_id, NOT a
 * variant id: the processor maps items to variants through the index. The
 * intake only persists + enqueues; coalescing and the per-shop throttle live
 * in the processor (spec <webhooks>).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await intakeWebhook({ topic, shopDomain: shop, webhookId, payload });

  return new Response();
};
