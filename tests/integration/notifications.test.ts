/**
 * Phase 10 gate (spec <phases> "Phase 10: Email digest"):
 * digest selection, period idempotency, budget smoothing, unsubscribe
 * signature, and bounce display.
 *
 * No network: the transport is injected; the Resend webhook route is called
 * with locally-computed Svix signatures.
 */

// Set env BEFORE importing app modules: env.server.ts caches the parse and
// reads process.env only. RESEND_WEBHOOK_SECRET is optional in the schema,
// so the tests provide one.
process.env.RESEND_WEBHOOK_SECRET ??= "whsec_dGVzdC1zZWNyZXQtZm9yLXJlc2VuZC13ZWJob29r";
process.env.RESEND_API_KEY ??= "";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import "../helpers/shopify-test-env.js";
import { resetDb, disposeTestDb, testDb, createShop } from "../helpers/db.js";
import { digestPeriodKey, runDigestSend, selectDigestContent, sendDueDigests } from "../../app/notifications/digest.server.js";
import { signUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl } from "../../app/notifications/unsubscribe.server.js";
import { renderDigestEmail } from "../../app/notifications/email-render.server.js";
import { resendTransport, type EmailTransport, type EmailSendInput } from "../../app/notifications/resend.server.js";
import { defaultSendBudgetLimits } from "../../app/notifications/send-budget.server.js";
import { verifySvixSignature } from "../../app/routes/resend.webhook.js";
import { loader as unsubscribeLoader } from "../../app/routes/unsubscribe.js";

const db = testDb();

function fakeTransport(override?: Partial<EmailSendInput>): EmailTransport & { calls: EmailSendInput[] } {
  const calls: EmailSendInput[] = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
      return { id: `re_test_${calls.length}` };
    },
    ...override,
  } as EmailTransport & { calls: EmailSendInput[] };
}

function digestSettings(overrides: Record<string, unknown> = {}) {
  // day 3 = Thursday (0 = Monday), hour 9 local.
  return { enabled: true, email: "owner@example.com", day: 3, hour: 9, skipWhenEmpty: true, ...overrides };
}

async function seedIssues(shopId: string, firstSeenAt: Date, count: number) {
  for (let i = 0; i < count; i += 1) {
    await db.issue.create({
      data: {
        shopId,
        type: "MISSING_SKU",
        severity: "high",
        status: "open",
        variantGid: `gid://shopify/ProductVariant/seed-${firstSeenAt.getTime()}-${i}`,
        groupKey: `seed-${i}`,
        details: { product_title: "Test product" },
        firstSeenAt: new Date(firstSeenAt.getTime() + i * 1000),
      },
    });
  }
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disposeTestDb();
});

describe("digest period keys (ISO weeks in the shop time zone)", () => {
  it("computes ISO week keys for known dates and zones", () => {
    expect(digestPeriodKey(new Date("2026-10-08T12:00:00Z"), "UTC")).toBe("2026-W41");
    // Same instant, Pacific: still Oct 7 locally (Wednesday) — same week.
    expect(digestPeriodKey(new Date("2026-10-08T04:00:00Z"), "America/Los_Angeles")).toBe("2026-W41");
    // Oct 11 is Sunday; the following Monday starts W42.
    expect(digestPeriodKey(new Date("2026-10-11T23:00:00Z"), "UTC")).toBe("2026-W41");
    expect(digestPeriodKey(new Date("2026-10-12T15:00:00Z"), "America/Los_Angeles")).toBe("2026-W42");
    // Year boundary: 2026 is a long (53-week) ISO year; Jan 2 2027 is 2026-W53,
    // and the first Monday of 2027 starts 2027-W01.
    expect(digestPeriodKey(new Date("2027-01-02T12:00:00Z"), "UTC")).toBe("2026-W53");
    expect(digestPeriodKey(new Date("2027-01-04T12:00:00Z"), "UTC")).toBe("2027-W01");
  });
});

describe("digest selection", () => {
  it("counts new (since last digest) and total open issues, newest first", async () => {
    const shop = await createShop({ settings: { digest: digestSettings() } });
    await seedIssues(shop.id, new Date("2026-10-01T00:00:00Z"), 3); // before last digest
    await seedIssues(shop.id, new Date("2026-10-06T00:00:00Z"), 4); // after

    const selection = await selectDigestContent(shop.id, "2026-W41", db, new Date("2026-10-04T00:00:00Z"));
    expect(selection.totalOpen).toBe(7);
    expect(selection.newIssues).toHaveLength(4);
    expect(selection.newIssues[0].type).toBe("MISSING_SKU");
    expect(selection.newIssues[0].severity).toBe("high");
    expect(new Date(selection.newIssues[0].id).getTime()).toBeNaN(); // ids are cuids, not dates
  });

  it("without a last digest date every open issue counts as new", async () => {
    const shop = await createShop({ settings: { digest: digestSettings() } });
    await seedIssues(shop.id, new Date("2026-10-01T00:00:00Z"), 2);
    const selection = await selectDigestContent(shop.id, "2026-W41", db, null);
    expect(selection.newIssues).toHaveLength(2);
    expect(selection.totalOpen).toBe(2);
  });
});

describe("send flow", () => {
  it("sends once per period: second run is a no-op (period idempotency)", async () => {
    const shop = await createShop({ plan: "starter", settings: { digest: digestSettings() } });
    await seedIssues(shop.id, new Date("2026-10-06T00:00:00Z"), 2);
    const transport = fakeTransport();
    const now = new Date("2026-10-08T12:00:00Z");

    const first = await runDigestSend(shop.id, "2026-W41", { client: db, transport, now });
    const second = await runDigestSend(shop.id, "2026-W41", { client: db, transport, now });

    expect(first.status).toBe("sent");
    expect(second.status).toBe("already-sent");
    expect(transport.calls).toHaveLength(1);
    const logs = await db.notificationLog.findMany({ where: { shopId: shop.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("sent");
    expect(logs[0].providerId).toBe("re_test_1");
    // lastDigestAt moved so the next period selects only newer issues.
    expect(await db.shop.findUnique({ where: { id: shop.id } })).toMatchObject({ lastDigestAt: now });
  });

  it("sends an HTML + plain-text email with localized plurals and unsubscribe headers", async () => {
    const shop = await createShop({ plan: "starter", notifyLocale: "en", settings: { digest: digestSettings() } });
    await seedIssues(shop.id, new Date("2026-10-06T00:00:00Z"), 3);
    const transport = fakeTransport();
    await runDigestSend(shop.id, "2026-W41", { client: db, transport, now: new Date("2026-10-08T12:00:00Z") });

    const sent = transport.calls[0];
    expect(sent.to).toBe("owner@example.com");
    expect(sent.subject).toContain("weekly digest");
    expect(sent.text).toContain("3 new issues this week.");
    expect(sent.text).toContain("3 issues are still open");
    expect(sent.html).toContain("<html");
    // Spec <notifications> "Links": emails deep link via admin.shopify.com.
    expect(sent.text).toContain(`https://admin.shopify.com/store/${shop.shopHandle}/apps/app/issues/`);
    expect(sent.text).toContain(`https://admin.shopify.com/store/${shop.shopHandle}/apps/app`);
    const unsub = sent.headers?.["List-Unsubscribe"];
    expect(unsub).toMatch(/^<https?:\/\/.+\/unsubscribe\?token=v1\./);
    expect(sent.headers?.["List-Unsubscribe-Post"]).toBe("One-Click=Yes");
  });

  it("renders plural variants: one new issue uses the singular arm", () => {
    const content = renderDigestEmail({
      locale: "en",
      newCount: 1,
      openCount: 41,
      issues: [{ id: "i1", type: "DUPLICATE_SKU", severity: "high" }],
      issueUrl: (id) => `https://app.example.dev/app/issues/${id}`,
      appUrl: "https://app.example.dev/app",
      unsubscribeUrl: "https://app.example.dev/unsubscribe?token=v1.x.y",
    });
    expect(content.text).toContain("1 new issue this week.");
    expect(content.text).toContain("41 issues are still open");
    expect(content.text).toContain("Duplicate SKU");
    expect(content.html).toContain("High");
  });

  it("skips empty periods with a recorded reason when skipWhenEmpty is on", async () => {
    const shop = await createShop({ plan: "starter", settings: { digest: digestSettings({ skipWhenEmpty: true }) } });
    const transport = fakeTransport();
    const result = await runDigestSend(shop.id, "2026-W41", { client: db, transport });
    expect(result.status).toBe("skipped-empty");
    expect(transport.calls).toHaveLength(0);
    const log = await db.notificationLog.findFirst({ where: { shopId: shop.id } });
    expect(log?.status).toBe("skipped_empty");
  });

  it("sends even when nothing is new but issues remain open and skipWhenEmpty is off", async () => {
    const shop = await createShop({ plan: "starter", settings: { digest: digestSettings({ skipWhenEmpty: false }) } });
    await seedIssues(shop.id, new Date("2026-10-01T00:00:00Z"), 1);
    await db.shop.update({ where: { id: shop.id }, data: { lastDigestAt: new Date("2026-10-07T00:00:00Z") } });
    const transport = fakeTransport();
    const result = await runDigestSend(shop.id, "2026-W41", { client: db, transport });
    expect(result.status).toBe("sent");
    expect(transport.calls).toHaveLength(1);
    // Nothing new: the zero-count plural arm.
    expect(transport.calls[0].text).toContain("No new issues this week");
  });

  it("skips free-plan and disabled shops without recording", async () => {
    const freeShop = await createShop({ plan: "free", settings: { digest: digestSettings() } });
    const disabled = await createShop({ plan: "starter", settings: { digest: digestSettings({ enabled: false }) } });
    const transport = fakeTransport();
    expect(await runDigestSend(freeShop.id, "2026-W41", { client: db, transport })).toMatchObject({ status: "skipped-plan" });
    expect(await runDigestSend(disabled.id, "2026-W41", { client: db, transport })).toMatchObject({ status: "skipped-disabled" });
    expect(transport.calls).toHaveLength(0);
    expect(await db.notificationLog.count()).toBe(0);
  });

  it("records a failed send visibly (missing API key is never silent)", async () => {
    const shop = await createShop({ plan: "starter", settings: { digest: digestSettings() } });
    await seedIssues(shop.id, new Date("2026-10-06T00:00:00Z"), 1);
    const result = await runDigestSend(shop.id, "2026-W41", {
      client: db,
      transport: resendTransport(undefined),
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("missing_api_key");
    const log = await db.notificationLog.findFirstOrThrow({ where: { shopId: shop.id } });
    expect(log.status).toBe("failed");
    expect(log.errorCode).toBe("missing_api_key");
  });
});

describe("budget smoothing", () => {
  it("defers over-budget sends and re-enqueues for later (never drops)", async () => {
    const shopA = await createShop({ plan: "starter", settings: { digest: digestSettings({ email: "a@example.com" }) } });
    const shopB = await createShop({ plan: "starter", settings: { digest: digestSettings({ email: "b@example.com" }) } });
    await seedIssues(shopA.id, new Date("2026-10-06T00:00:00Z"), 1);
    await seedIssues(shopB.id, new Date("2026-10-06T00:00:00Z"), 1);
    const transport = fakeTransport();
    const now = new Date("2026-10-08T12:00:00Z");
    const tightBudget = { dailyLimit: 1, monthlyLimit: 10, perTick: 5 };

    const first = await runDigestSend(shopA.id, "2026-W41", { client: db, transport, now, limits: tightBudget });
    expect(first.status).toBe("sent");

    const jobsBefore = await db.job.count();
    const deferred = await runDigestSend(shopB.id, "2026-W41", { client: db, transport, now, limits: tightBudget });
    expect(deferred.status).toBe("deferred-budget");
    expect(transport.calls).toHaveLength(1);
    // A pending retry job exists with a future runAt and a stable dedupe key.
    const retry = await db.job.findFirstOrThrow({ where: { kind: "digest_send", status: "pending" } });
    expect(retry.shopId).toBe(shopB.id);
    expect(retry.dedupeKey).toBe(`digest:${shopB.id}:2026-W41`);
    expect(retry.runAt.getTime()).toBeGreaterThan(now.getTime());
    expect(await db.job.count()).toBe(jobsBefore + 1);
    // And no log row was created for the deferred shop.
    expect(await db.notificationLog.count({ where: { shopId: shopB.id } })).toBe(0);
  });

  it("smooths due digests per tick: perTick caps how many are enqueued", async () => {
    const now = new Date("2026-10-08T07:30:00Z"); // Thursday 09:30 in Berlin (day 3, hour 9)
    for (const domain of ["a", "b", "c"]) {
      await createShop({ shopDomain: `${domain}.myshopify.com`, plan: "starter", timezone: "Europe/Berlin", settings: { digest: digestSettings() } });
    }
    const limits = { dailyLimit: 100, monthlyLimit: 3000, perTick: 2 };
    const enqueued = await sendDueDigests(now, db, { info: () => {}, debug: () => {}, warn: () => {} }, limits);
    expect(enqueued).toBe(2);
    // The third shop is picked up by the next tick.
    const more = await sendDueDigests(new Date(now.getTime() + 60_000), db, { info: () => {}, debug: () => {}, warn: () => {} }, limits);
    expect(more).toBe(1);
  });

  it("due computation matches the configured local day+hour and skips free shops", async () => {
    const due = await createShop({ shopDomain: "due.myshopify.com", plan: "starter", timezone: "Europe/Berlin", settings: { digest: digestSettings({ day: 3, hour: 9 }) } });
    await createShop({ shopDomain: "notdue.myshopify.com", plan: "starter", timezone: "Europe/Berlin", settings: { digest: digestSettings({ day: 3, hour: 10 }) } });
    await createShop({ shopDomain: "free.myshopify.com", plan: "free", timezone: "Europe/Berlin", settings: { digest: digestSettings() } });
    const now = new Date("2026-10-08T07:30:00Z"); // 09:30 in Berlin -> hour 9
    const enqueued = await sendDueDigests(now, db, { info: () => {}, debug: () => {}, warn: () => {} }, defaultSendBudgetLimits());
    expect(enqueued).toBe(1);
    const jobs = await db.job.findMany({ where: { kind: "digest_send" } });
    expect(jobs.map((j) => j.shopId)).toEqual([due.id]);
    expect(jobs[0].dedupeKey).toBe(`digest:${due.id}:2026-W41`);
  });

  it("is idempotent for the same period within due computation", async () => {
    const now = new Date("2026-10-08T07:30:00Z");
    await createShop({ plan: "starter", timezone: "Europe/Berlin", settings: { digest: digestSettings() } });
    const logger = { info: () => {}, debug: () => {}, warn: () => {} };
    await sendDueDigests(now, db, logger, defaultSendBudgetLimits());
    const again = await sendDueDigests(now, db, logger, defaultSendBudgetLimits());
    expect(again).toBe(0);
    expect(await db.job.count({ where: { kind: "digest_send" } })).toBe(1);
  });
});

describe("unsubscribe signature", () => {
  const key = "v1:" + Buffer.from("a".repeat(32)).toString("base64");

  it("signs and verifies a token round-trip", () => {
    const token = signUnsubscribeToken({ shopId: "shop123", email: "owner@example.com" }, key);
    expect(token.startsWith("v1.")).toBe(true);
    expect(verifyUnsubscribeToken(token, key)).toEqual({ shopId: "shop123", email: "owner@example.com" });
  });

  it("rejects tampered payloads and signatures", () => {
    const token = signUnsubscribeToken({ shopId: "shop123", email: "owner@example.com" }, key);
    const parts = token.split(".");
    const tamperedPayload = `v1.${Buffer.from(JSON.stringify({ shopId: "other", email: "owner@example.com" })).toString("base64url")}.${parts[2]}`;
    expect(verifyUnsubscribeToken(tamperedPayload, key)).toBeNull();
    expect(verifyUnsubscribeToken(token, "v1:" + Buffer.from("b".repeat(32)).toString("base64"))).toBeNull();
    expect(verifyUnsubscribeToken("not-a-token", key)).toBeNull();
    expect(verifyUnsubscribeToken("", key)).toBeNull();
  });

  it("builds a public unsubscribe URL with locale", () => {
    const token = signUnsubscribeToken({ shopId: "s", email: "e@example.com" }, key);
    const url = unsubscribeUrl("https://app.example.dev", token, "fr");
    expect(url).toBe(`https://app.example.dev/unsubscribe?token=${encodeURIComponent(token)}&locale=fr`);
    expect(unsubscribeUrl("https://app.example.dev", token, "en")).not.toContain("locale");
  });

  it("the route disables the digest for the shop (one-click, no auth)", async () => {
    const shop = await createShop({ plan: "starter", settings: { digest: digestSettings() } });
    const token = signUnsubscribeToken({ shopId: shop.id, email: "owner@example.com" });
    const request = new Request(`https://app.example.dev/unsubscribe?token=${encodeURIComponent(token)}`);
    const data = await unsubscribeLoader({ request, params: {}, context: {} } as never);
    expect(data.done).toBe(true);
    const updated = await db.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect((updated.settings as { digest: { enabled: boolean } }).digest.enabled).toBe(false);
    // Other digest settings survive.
    expect((updated.settings as { digest: { email?: string } }).digest.email).toBe("owner@example.com");
  });

  it("the route shows the invalid page for bad tokens and never writes", async () => {
    const shop = await createShop({ plan: "starter", settings: { digest: digestSettings() } });
    const request = new Request("https://app.example.dev/unsubscribe?token=garbage");
    const data = await unsubscribeLoader({ request, params: {}, context: {} } as never);
    expect(data.done).toBe(false);
    const updated = await db.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect((updated.settings as { digest: { enabled: boolean } }).digest.enabled).toBe(true);
  });
});

describe("resend webhook: signature, dedupe, bounce display", () => {
  const secret = process.env.RESEND_WEBHOOK_SECRET!;

  function svixHeaders(body: string, { stale = false, wrongSecret = false } = {}) {
    const timestamp = Math.floor(Date.now() / 1000) - (stale ? 3600 : 0);
    const material = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const sig = createHmac("sha256", wrongSecret ? Buffer.from("other") : material)
      .update(`msg_test.${timestamp}.${body}`)
      .digest("base64");
    return {
      "svix-id": "msg_test",
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${sig}`,
    };
  }

  it("verifies signatures and rejects stale or wrong-key ones", () => {
    const body = JSON.stringify({ type: "email.bounced" });
    expect(verifySvixSignature(secret, "msg_test", svixHeaders(body)["svix-timestamp"], body, svixHeaders(body)["svix-signature"])).toBe(true);
    expect(verifySvixSignature(secret, "msg_test", svixHeaders(body, { stale: true })["svix-timestamp"], body, svixHeaders(body, { stale: true })["svix-signature"])).toBe(false);
    expect(verifySvixSignature(secret, "msg_test", svixHeaders(body, { wrongSecret: true })["svix-timestamp"], body, svixHeaders(body, { wrongSecret: true })["svix-signature"])).toBe(false);
  });

  it("marks the matching NotificationLog bounced and shows it in Settings", async () => {
    const { action } = await import("../../app/routes/resend.webhook.js");
    const shop = await createShop({ plan: "starter", settings: { digest: digestSettings() } });
    await seedIssues(shop.id, new Date("2026-10-06T00:00:00Z"), 1);
    const transport = fakeTransport();
    await runDigestSend(shop.id, "2026-W41", { client: db, transport });
    const log = await db.notificationLog.findFirstOrThrow({ where: { shopId: shop.id } });
    expect(log.providerId).toBe("re_test_1");

    const body = JSON.stringify({
      type: "email.bounced",
      data: { email_id: log.providerId, to: "owner@example.com", error: { message: "550 mailbox unavailable" } },
    });
    const ok = await action({ request: new Request("https://app.example.dev/resend/webhook", { method: "POST", headers: svixHeaders(body), body }) } as never);
    expect(ok.status).toBe(200);
    const updated = await db.notificationLog.findFirstOrThrow({ where: { shopId: shop.id } });
    expect(updated.status).toBe("bounced");
    expect(updated.errorCode).toContain("550 mailbox unavailable");

    // Settings displays it: same query as the settings loader.
    const problems = await db.notificationLog.findMany({
      where: { shopId: shop.id, channel: "email", status: { in: ["bounced", "failed", "complained"] } },
      orderBy: { sentAt: "desc" },
      take: 5,
      select: { status: true, errorCode: true, sentAt: true, periodKey: true },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ status: "bounced", periodKey: "2026-W41" });
  });

  it("rejects unverified requests with 401 and dedupes on svix-id", async () => {
    const { action } = await import("../../app/routes/resend.webhook.js");
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_x" } });
    const headers = svixHeaders(body, { wrongSecret: true });
    const rejected = await action({ request: new Request("https://app.example.dev/resend/webhook", { method: "POST", headers, body }) } as never);
    expect(rejected.status).toBe(401);

    const good = svixHeaders(body);
    const first = await action({ request: new Request("https://app.example.dev/resend/webhook", { method: "POST", headers: good, body }) } as never);
    expect(first.status).toBe(200);
    const second = await action({ request: new Request("https://app.example.dev/resend/webhook", { method: "POST", headers: good, body }) } as never);
    expect(second.status).toBe(200);
    expect(await db.webhookEvent.count({ where: { shopDomain: "resend" } })).toBe(1);
  });
});
