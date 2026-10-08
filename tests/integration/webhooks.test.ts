import { TEST_API_SECRET } from "../helpers/shopify-test-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import { shopifyHmacBase64 } from "../../app/lib/timing-safe.server.js";
import {
  resetDb,
  disposeTestDb,
  testDb,
  createShop,
} from "../helpers/db.js";
import { intakeWebhook, processWebhookEvent, getWebhookProcessor, storageTopicForm } from "../../app/webhooks/intake.server.js";
import { uninstallShop } from "../../app/webhooks/uninstall.server.js";
import { redactShop } from "../../app/webhooks/redact.server.js";
import { registerLifecycleWebhookProcessors } from "../../app/webhooks/processors.server.js";
import { mapSubscriptionsToPlan, refreshShopPlan, currentPlan, PLAN_CACHE_TTL_MS } from "../../app/billing/subscription.server.js";

const SECRET = TEST_API_SECRET;
const SHOP = "webhook-test.myshopify.com";

// Route actions are plain (request) => Response functions: build a signed
// Request and call the action directly. authenticate.webhook validates the
// real HMAC header over the raw body with SHOPIFY_API_SECRET from env.
const { action: uninstalledAction } = await import("../../app/routes/webhooks.app.uninstalled.js");
const { action: scopesAction } = await import("../../app/routes/webhooks.app.scopes_update.js");
const { action: complianceAction } = await import("../../app/routes/webhooks.compliance.js");
const { action: subscriptionsAction } = await import("../../app/routes/webhooks.app-subscriptions.update.js");

registerLifecycleWebhookProcessors();

function webhookRequest(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = JSON.stringify(body);
  const hmac = shopifyHmacBase64(raw, SECRET);
  return new Request("https://app.example.dev/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": "app/uninstalled",
      "x-shopify-shop-domain": SHOP,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": `wh-${Math.floor(Math.random() * 1e9)}`,
      "x-shopify-hmac-sha256": hmac,
      ...headers,
    },
    body: raw,
  });
}

let n = 0;
function nextWebhookId(): string {
  n += 1;
  return `wh-test-${n}`;
}

/**
 * The route action only reads `request`; url/pattern are runtime-injected by
 * React Router and irrelevant here, so a minimal cast keeps the calls honest
 * about the parts we actually construct.
 */
function asActionArgs(request: Request): ActionFunctionArgs {
  return { request, params: {}, context: {} } as unknown as ActionFunctionArgs;
}

beforeAll(async () => {
  await testDb().$queryRaw`SELECT 1`;
});

beforeEach(async () => {
  await resetDb();
  await createShop({ shopDomain: SHOP });
});

afterAll(async () => {
  await disposeTestDb();
});

describe("webhook intake", () => {
  it("rejects a tampered body with 401 and persists nothing", async () => {
    const request = webhookRequest({ shop_domain: SHOP });
    const forged = new Request(request.url, {
      method: "POST",
      headers: { ...request.headers, "x-shopify-hmac-sha256": shopifyHmacBase64("tampered", SECRET) },
      body: JSON.stringify({ shop_domain: SHOP }),
    });
    await expect(uninstalledAction(asActionArgs(forged))).rejects.toThrow();
    expect(await testDb().webhookEvent.count()).toBe(0);
  });

  it("persists the event and enqueues a webhook_process job with a dedupe key", async () => {
    const id = nextWebhookId();
    const result = await intakeWebhook({ topic: "app/scopes_update", shopDomain: SHOP, webhookId: id, payload: { current: ["read_products"] } });
    expect(result.duplicate).toBe(false);

    const db = testDb();
    const event = await db.webhookEvent.findUnique({ where: { webhookId: id } });
    expect(event?.topic).toBe("app/scopes_update");
    expect(event?.shopDomain).toBe(SHOP);
    expect(event?.processedAt).toBeNull();

    const job = await db.job.findFirst({ where: { kind: "webhook_process" } });
    expect(job?.dedupeKey).toBe(`wh:${id}`);
    expect(job?.payload).toEqual({ webhookEventId: event?.id });
  });

  it("returns a duplicate 200-equivalent result on replayed webhook ids", async () => {
    const id = nextWebhookId();
    const first = await intakeWebhook({ topic: "app/uninstalled", shopDomain: SHOP, webhookId: id, payload: {} });
    const second = await intakeWebhook({ topic: "app/uninstalled", shopDomain: SHOP, webhookId: id, payload: {} });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await testDb().webhookEvent.count()).toBe(1);
    expect(await testDb().job.count({ where: { kind: "webhook_process" } })).toBe(1);
  });

  it("scrubs customer PII from compliance payloads before storing", async () => {
    const id = nextWebhookId();
    await intakeWebhook({
      topic: "customers/data_request",
      shopDomain: SHOP,
      webhookId: id,
      payload: { shop_domain: SHOP, customer: { id: 42, email: "jane@example.com", phone: "+1-555-0100" } },
    });
    const event = await testDb().webhookEvent.findUnique({ where: { webhookId: id } });
    expect(event?.payload).toEqual({ shop_domain: SHOP });
    const stored = JSON.stringify(event?.payload);
    expect(stored).not.toContain("jane@example.com");
    expect(stored).not.toContain("+1-555-0100");
  });

  it("marks unknown topics processed without retrying them forever", async () => {
    const id = nextWebhookId();
    await intakeWebhook({ topic: "totally/unknown", shopDomain: SHOP, webhookId: id, payload: { x: 1 } });
    const event = await testDb().webhookEvent.findUnique({ where: { webhookId: id } });
    await processWebhookEvent(event!.id);
    const after = await testDb().webhookEvent.findUnique({ where: { webhookId: id } });
    expect(after?.processedAt).not.toBeNull();
    expect(after?.attempts).toBe(1);
  });

  it("is idempotent when the same event is processed twice", async () => {
    const db = testDb();
    const { eventId } = await intakeWebhook({ topic: "app/uninstalled", shopDomain: SHOP, webhookId: nextWebhookId(), payload: {} });
    await processWebhookEvent(eventId!);
    const first = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    expect(first?.uninstalledAt).not.toBeNull();

    // Second run must not crash and must not resurrect anything.
    await processWebhookEvent(eventId!);
    const after = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    expect(after?.uninstalledAt).not.toBeNull();
    const event = await db.webhookEvent.findUnique({ where: { id: eventId! } });
    expect(event?.attempts).toBe(1);
  });
});

describe("app/uninstalled", () => {
  it("the route action deletes sessions synchronously and marks the shop uninstalled", async () => {
    const db = testDb();
    await db.session.create({
      data: {
        id: `offline_${SHOP}`,
        shop: SHOP,
        state: "state",
        isOnline: false,
        scope: "read_products",
        accessToken: "enc:whatever",
        expires: new Date(Date.now() + 3600_000),
      },
    });

    const response = await uninstalledAction(
      asActionArgs(webhookRequest({ shop_domain: SHOP }, { "x-shopify-webhook-id": nextWebhookId() })),
    );
    expect(response.status).toBe(200);
    expect(await db.session.count()).toBe(0);

    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    expect(shop?.uninstalledAt).not.toBeNull();
  });

  it("cancels pending jobs and clears telegram link tokens, but keeps catalog data", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await db.job.create({ data: { kind: "digest_send", payload: {}, shopId: shop!.id, status: "pending" } });
    await db.job.create({ data: { kind: "scan_start", payload: {}, shopId: shop!.id, status: "done" } });
    await db.scan.create({ data: { shopId: shop!.id, trigger: "manual", status: "completed" } });
    await db.telegramLinkToken.create({ data: { shopId: shop!.id, tokenHash: "hash", expiresAt: new Date(Date.now() + 3600_000) } });

    await uninstallShop(SHOP);

    expect(await db.job.count({ where: { status: "pending" } })).toBe(0);
    expect(await db.job.count({ where: { status: "done" } })).toBe(1); // history kept
    expect(await db.telegramLinkToken.count()).toBe(0);
    expect(await db.scan.count()).toBe(1); // catalog data kept until shop/redact
  });

  it("is safe when the shop row does not exist (replay after redact)", async () => {
    await testDb().shop.deleteMany({ where: { shopDomain: SHOP } });
    await expect(uninstallShop(SHOP)).resolves.not.toThrow();
  });
});

describe("app/scopes_update", () => {
  it("stores new scopes and disables auto-tag when write_products is removed", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await db.shop.update({ where: { id: shop!.id }, data: { scopes: "read_products,write_products", settings: { autoTag: true } as never } });

    const response = await scopesAction(
      asActionArgs(
        webhookRequest(
          { previous: ["read_products", "write_products"], current: ["read_products"] },
          { "x-shopify-topic": "app/scopes_update", "x-shopify-webhook-id": nextWebhookId() },
        ),
      ),
    );
    expect(response.status).toBe(200);

    // The route only intakes; the async job applies the change.
    const event = await db.webhookEvent.findFirst({ orderBy: { id: "desc" } });
    await processWebhookEvent(event!.id);

    const after = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    expect(after?.scopes).toBe("read_products");
    expect((after?.settings as { autoTag?: boolean })?.autoTag).toBe(false);
  });

  it("keeps auto-tag enabled when write_products survives", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await db.shop.update({ where: { id: shop!.id }, data: { settings: { autoTag: true } as never } });

    const id = nextWebhookId();
    await intakeWebhook({ topic: "app/scopes_update", shopDomain: SHOP, webhookId: id, payload: { current: ["read_products", "write_products"] } });
    const event = await db.webhookEvent.findUnique({ where: { webhookId: id } });
    await processWebhookEvent(event!.id);

    const after = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    expect(after?.scopes).toBe("read_products,write_products");
    expect((after?.settings as { autoTag?: boolean })?.autoTag).toBe(true);
  });
});

describe("compliance topics", () => {
  it("shop/redact deletes every row for the shop across all tables", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    await db.session.create({
      data: { id: `offline_${SHOP}`, shop: SHOP, state: "s", isOnline: false, scope: "read_products", accessToken: "enc:x", expires: new Date(Date.now() + 3600_000) },
    });
    await db.scan.create({ data: { shopId: shop!.id, trigger: "manual", status: "completed" } });
    await db.job.create({ data: { kind: "stub", payload: {}, shopId: shop!.id, status: "pending" } });
    await intakeWebhook({ topic: "shop/redact", shopDomain: SHOP, webhookId: nextWebhookId(), payload: { shop_domain: SHOP } });

    await redactShop(SHOP);

    expect(await db.shop.count({ where: { shopDomain: SHOP } })).toBe(0);
    expect(await db.session.count({ where: { shop: SHOP } })).toBe(0);
    expect(await db.scan.count()).toBe(0);
    expect(await db.job.count({ where: { shopId: shop!.id } })).toBe(0);
    expect(await db.webhookEvent.count({ where: { shopDomain: SHOP } })).toBe(0);
  });

  it("the compliance route accepts and processes all three topics", async () => {
    for (const topic of ["customers/data_request", "customers/redact", "shop/redact"]) {
      const db = testDb();
      // shop/redact deletes the shop row; recreate for each iteration
      const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
      if (!shop) await createShop({ shopDomain: SHOP });
      const response = await complianceAction(
        asActionArgs(
          webhookRequest(
            topic === "shop/redact" ? { shop_domain: SHOP } : { shop_domain: SHOP, customer: { id: 1, email: "x@y.z" } },
            { "x-shopify-topic": topic, "x-shopify-webhook-id": nextWebhookId() },
          ),
        ),
      );
      expect(response.status).toBe(200);
      // The library delivers topics in storage form ("CUSTOMERS_DATA_REQUEST").
      const event = await db.webhookEvent.findFirst({
        where: { topic: { in: [topic, storageTopicForm(topic)] } },
        orderBy: { id: "desc" },
      });
      expect(event).not.toBeNull();
      // No customer PII ever persisted:
      expect(JSON.stringify(event?.payload)).not.toContain("x@y.z");
      if (event) await processWebhookEvent(event.id);
    }
    expect(await testDb().shop.count({ where: { shopDomain: SHOP } })).toBe(0); // redact ran
  });
});

describe("app_subscriptions/update + plan cache", () => {
  it("maps the highest ACTIVE subscription to a plan", () => {
    expect(mapSubscriptionsToPlan([{ name: "Pro", status: "ACTIVE" }, { name: "Starter", status: "ACTIVE" }])).toBe("pro");
    expect(mapSubscriptionsToPlan([{ name: "starter", status: "ACTIVE" }])).toBe("starter");
    expect(mapSubscriptionsToPlan([{ name: "Pro", status: "CANCELLED" }, { name: "Starter", status: "ACTIVE" }])).toBe("starter");
    expect(mapSubscriptionsToPlan([{ name: "Pro", status: "PENDING" }])).toBe("free");
    expect(mapSubscriptionsToPlan([])).toBe("free");
    expect(mapSubscriptionsToPlan([{ name: "Enterprise Custom", status: "ACTIVE" }])).toBe("free");
  });

  it("refreshShopPlan stores the plan; currentPlan serves the 5-minute cache without re-fetching", async () => {
    const db = testDb();
    const shop = await db.shop.findUnique({ where: { shopDomain: SHOP } });
    const executor = {
      graphql: async () => ({
        data: {
          currentAppInstallation: {
            activeSubscriptions: { nodes: [{ name: "Pro", status: "ACTIVE" }] },
          },
        },
      }),
    };
    const plan = await refreshShopPlan(shop!.id, executor as never, db);
    expect(plan).toBe("pro");
    const stored = await db.shop.findUnique({ where: { id: shop!.id } });
    expect(stored?.plan).toBe("pro");
    expect(stored?.planCheckedAt).not.toBeNull();

    // No executor + fresh cache: no fetch attempted, cached value returned.
    const cached = await currentPlan(shop!.id, { client: db });
    expect(cached).toBe("pro");

    // Stale cache + no executor: stale value returned, never "free"-flipped.
    await db.shop.update({ where: { id: shop!.id }, data: { planCheckedAt: new Date(Date.now() - PLAN_CACHE_TTL_MS - 1000) } });
    expect(await currentPlan(shop!.id, { client: db })).toBe("pro");

    // Stale cache + failing executor: keeps the cached plan.
    const failing = { graphql: async () => { throw new Error("boom"); } };
    expect(await currentPlan(shop!.id, { client: db, executor: failing as never })).toBe("pro");
  });

  it("the subscriptions route intakes the event", async () => {
    const response = await subscriptionsAction(
      asActionArgs(
        webhookRequest(
          { app_subscription: { name: "Pro", status: "ACTIVE" } },
          { "x-shopify-topic": "app_subscriptions/update", "x-shopify-webhook-id": nextWebhookId() },
        ),
      ),
    );
    expect(response.status).toBe(200);
    const topic = "app_subscriptions/update";
    const count = await testDb().webhookEvent.count({
      where: { topic: { in: [topic, storageTopicForm(topic)] } },
    });
    expect(count).toBe(1);
  });
});

describe("processor registry", () => {
  it("registers exactly one processor per lifecycle topic", () => {
    for (const topic of [
      "app/uninstalled",
      "app/scopes_update",
      "app_subscriptions/update",
      "customers/data_request",
      "customers/redact",
      "shop/redact",
      "bulk_operations/finish",
    ]) {
      expect(getWebhookProcessor(topic), topic).toBeTypeOf("function");
    }
  });
});
