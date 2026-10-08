import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { intakeWebhook } from "../webhooks/intake.server.js";

/**
 * app_subscriptions/update: the webhook_process job re-reads
 * currentAppInstallation.activeSubscriptions (the live state beats the
 * payload's possibly-PENDING status) and refreshes the cached plan.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await intakeWebhook({ topic, shopDomain: shop, webhookId, payload });

  return new Response();
};
