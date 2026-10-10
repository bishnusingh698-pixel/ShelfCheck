import type { ActionFunctionArgs } from "react-router";
import { createHmac } from "node:crypto";
import { env } from "../env.server.js";
import { constantTimeEqual } from "../lib/crypto.server.js";
import { logger } from "../lib/logger.server.js";

/**
 * Resend webhook (spec <notifications>): delivery events for sent digests.
 *
 * Signature: Svix-style — headers `svix-id`, `svix-timestamp`,
 * `svix-signature` (space-delimited `v1,<base64 HMAC-SHA256>` list), HMAC
 * over `<id>.<timestamp>.<raw body>` with RESEND_WEBHOOK_SECRET
 * (`whsec_<base64>`). Tolerance: 5 minutes. Dedupe on `svix-id` (unique
 * webhookId in webhook_events).
 *
 * `email.bounced` / `email.failed` / `email.complained` mark the matching
 * NotificationLog (by providerId) so Settings can show delivery problems.
 * Always 200 after verification — never re-trigger Resend's retry loop for
 * business-level no-ops.
 */

const TOLERANCE_SECONDS = 300;

function svixSecretMaterial(secret: string): Buffer {
  if (secret.startsWith("whsec_")) {
    return Buffer.from(secret.slice("whsec_".length), "base64");
  }
  return Buffer.from(secret, "utf8");
}

export function verifySvixSignature(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
  signatureList: string,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const material = svixSecretMaterial(secret);
  const expected = createHmac("sha256", material).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return signatureList
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .some((part) => constantTimeEqual(part.slice(3), expected));
}

function logStatusForEventType(type: string): "bounced" | "failed" | "complained" | "sent" | null {
  switch (type) {
    case "email.bounced":
      return "bounced";
    case "email.failed":
      return "failed";
    case "email.complained":
      return "complained";
    case "email.delivered":
      return "sent";
    default:
      return null;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Unconfigured: fail so Resend retries once the secret is set (never
    // accept an unverifiable request).
    return new Response(JSON.stringify({ error: "webhook_secret_not_configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const rawBody = await request.text();
  const id = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp") ?? "";
  const signatureList = request.headers.get("svix-signature") ?? "";
  if (!id || !timestamp || !verifySvixSignature(secret, id, timestamp, rawBody, signatureList)) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let event: { type?: string; data?: { email_id?: string; to?: string; error?: { message?: string } | string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    // Signed but unparsable — nothing sensible to do; ack to stop retries.
    logger.warn({ svixId: id }, "resend webhook: signed but unparsable body");
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }

  const { db } = await import("../db.server.js");
  try {
    await db.webhookEvent.create({
      data: { id, shopDomain: "resend", topic: `resend:${event.type ?? "unknown"}`, webhookId: id, payload: { type: event.type } },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      // Already processed (dedupe on svix-id).
      return new Response(JSON.stringify({ ok: true, deduped: true }), { headers: { "content-type": "application/json" } });
    }
    throw error;
  }

  const status = event.type ? logStatusForEventType(event.type) : null;
  const providerId = event.data?.email_id ?? null;
  if (status && providerId) {
    const errorCode =
      typeof event.data?.error === "string"
        ? event.data.error.slice(0, 200)
        : event.data?.error?.message?.slice(0, 200) ?? null;
    await db.notificationLog.updateMany({
      where: { providerId },
      data: status === "sent" ? { status: "sent" } : { status, errorCode },
    });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}
