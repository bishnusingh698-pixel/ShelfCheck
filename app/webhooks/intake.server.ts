import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { logger } from "../lib/logger.server.js";
import { enqueue, isUniqueViolation, isRecordNotFound } from "../jobs/queue.server.js";

/**
 * Shared webhook intake (spec <webhooks> "Every handler"):
 *  1. HMAC verification happens BEFORE this module — the route calls
 *     `authenticate.webhook(request)` from @shopify/shopify-app-react-router,
 *     which validates the base64 HMAC over the RAW body with a timing-safe
 *     compare (verified: dist/cjs/lib/utils/hmac-validator.js +
 *     server/authenticate/webhooks/authenticate.js) and throws 401 on mismatch.
 *  2. Dedupe on X-Shopify-Webhook-Id (unique index on webhook_events.webhookId).
 *  3. Persist to webhook_events.
 *  4. Enqueue a webhook_process job.
 *  5. Return 200 fast — all real work runs in the job.
 *
 * Compliance topics (customers/data_request, customers/redact) are stored
 * WITHOUT customer PII: only the shop domain is kept (spec: "log the request
 * without PII").
 */

export type WebhookTopic =
  | "app/uninstalled"
  | "app/scopes_update"
  | "app_subscriptions/update"
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact"
  | "bulk_operations/finish"
  | "products/create"
  | "products/update"
  | "products/delete"
  | "inventory_levels/update";

const COMPLIANCE_CUSTOMER_TOPICS = new Set(["customers/data_request", "customers/redact"]);

export interface IntakeInput {
  /** Shopify topic header, e.g. "app/uninstalled", "products/update". */
  topic: string;
  shopDomain: string;
  webhookId: string;
  payload: unknown;
  /** Redact the stored payload to {shop_domain} (compliance topics). */
  scrubPayload?: boolean;
  client?: PrismaClient;
}

export interface IntakeResult {
  duplicate: boolean;
  eventId: string | null;
}

/** Persist + enqueue one webhook delivery. Duplicate ids are a no-op (200). */
export async function intakeWebhook(input: IntakeInput): Promise<IntakeResult> {
  const client = input.client ?? db;
  const shop = await client.shop.findUnique({ where: { shopDomain: input.shopDomain } });
  const payload =
    input.scrubPayload || COMPLIANCE_CUSTOMER_TOPICS.has(input.topic)
      ? ({ shop_domain: input.shopDomain } as Record<string, unknown>)
      : ((input.payload ?? {}) as Record<string, unknown>);

  let created;
  try {
    created = await client.webhookEvent.create({
      data: {
        shopId: shop?.id ?? null,
        shopDomain: input.shopDomain,
        topic: input.topic,
        webhookId: input.webhookId,
        payload: payload as never,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Replayed delivery: Shopify retries on any non-200; idempotent 200.
      logger.debug({ topic: input.topic, webhookId: input.webhookId }, "duplicate webhook delivery");
      return { duplicate: true, eventId: null };
    }
    throw error;
  }

  await enqueue(
    {
      kind: "webhook_process",
      payload: { webhookEventId: created.id },
      shopId: shop?.id ?? null,
      dedupeKey: `wh:${input.webhookId}`,
    },
    client,
  );

  logger.info({ topic: input.topic, shopId: shop?.id ?? null, eventId: created.id }, "webhook accepted");
  return { duplicate: false, eventId: created.id };
}

/** A webhook event row as loaded for processing. */
export interface StoredWebhookEvent {
  id: string;
  shopId: string | null;
  shopDomain: string;
  topic: string;
  payload: Record<string, unknown>;
}

export type WebhookProcessor = (
  event: StoredWebhookEvent,
  client: PrismaClient,
) => Promise<void>;

/** Topic → processor registry. Extended per phase (products land in Phase 7). */
const processors = new Map<string, WebhookProcessor>();

/**
 * The webhook topic arrives in two shapes:
 *  - human form ("app/scopes_update") as used in shopify.app.toml and tests,
 *  - storage form ("APP_SCOPES_UPDATE") — @shopify/shopify-api normalizes
 *    `authenticate.webhook`'s topic header via topicForStorage()
 *    (`toUpperCase().replace(/\/|\./g, "_")`; verified in
 *    node_modules/@shopify/shopify-api/dist/cjs/lib/webhooks/registry.js).
 * The round-trip is lossy ("app_subscriptions/update" ↔ "APP_SUBSCRIPTIONS_UPDATE"),
 * so processors are registered under BOTH forms instead of being re-derived.
 */
export function storageTopicForm(topic: string): string {
  return topic.toUpperCase().replace(/\/|\./g, "_");
}

export function registerWebhookProcessor(topic: string, processor: WebhookProcessor): void {
  processors.set(topic, processor);
  processors.set(storageTopicForm(topic), processor);
}

export function getWebhookProcessor(topic: string): WebhookProcessor | undefined {
  return processors.get(topic) ?? processors.get(storageTopicForm(topic));
}

/**
 * Process one persisted webhook event (runs inside the webhook_process job).
 * Idempotent: an event with processedAt set is a no-op. Handlers throw to
 * trigger the job retry/backoff; attempts are recorded.
 */
export async function processWebhookEvent(
  eventId: string,
  client: PrismaClient = db,
): Promise<void> {
  const event = await client.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) {
    logger.warn({ eventId }, "webhook event disappeared before processing");
    return;
  }
  if (event.processedAt) return;

  const processor = getWebhookProcessor(event.topic);
  if (!processor) {
    // Unknown topics are acknowledged without error: Shopify may add payloads
    // we never subscribed to. Recorded, never retried.
    await client.webhookEvent.update({
      where: { id: event.id },
      data: {
        processedAt: new Date(),
        attempts: { increment: 1 },
        payload: { unknown_topic: event.topic } as never,
      },
    });
    logger.warn({ topic: event.topic, eventId: event.id }, "webhook topic has no processor");
    return;
  }

  await processor(
    {
      id: event.id,
      shopId: event.shopId,
      shopDomain: event.shopDomain,
      topic: event.topic,
      payload: (event.payload ?? {}) as Record<string, unknown>,
    },
    client,
  );
  try {
    await client.webhookEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), attempts: { increment: 1 } },
    });
  } catch (error) {
    // shop/redact erases every row for the shop — including this event — so
    // the bookkeeping update can legitimately find nothing left. Erasure wins.
    if (isRecordNotFound(error)) return;
    throw error;
  }
}
