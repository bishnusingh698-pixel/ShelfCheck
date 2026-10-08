import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { intakeWebhook } from "../webhooks/intake.server.js";

/**
 * bulk_operations/finish: the webhook_process job finds the running scan by
 * the operation id, streams + parses the result file, and completes the scan.
 * The scan_poll fallback job makes this delivery optional, not load-bearing.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);

  await intakeWebhook({ topic, shopDomain: shop, webhookId, payload });

  return new Response();
};
