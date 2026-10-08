import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { intakeWebhook } from "../webhooks/intake.server.js";

/**
 * Compliance topics: customers/data_request, customers/redact, shop/redact.
 * All three are declared in shopify.app.toml with this single URI.
 *
 * Customer topics carry PII, so the intake stores them scrubbed to
 * {shop_domain}; their processor only logs an acknowledgement (this app
 * stores no customer data). shop/redact deletes every row for the shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await intakeWebhook({
    topic,
    shopDomain: shop,
    webhookId,
    payload,
    scrubPayload: true,
  });

  return new Response();
};
