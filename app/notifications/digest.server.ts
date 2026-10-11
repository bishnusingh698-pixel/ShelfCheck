import type { PrismaClient } from "@prisma/client";
import { enqueue } from "../jobs/queue.server.js";
import { env } from "../env.server.js";
import { appPath } from "../lib/admin-urls.js";
import { renderDigestEmail } from "./email-render.server.js";
import { resendTransport, type EmailTransport } from "./resend.server.js";
import { budgetUsage, defaultSendBudgetLimits, type SendBudgetLimits } from "./send-budget.server.js";
import { signUnsubscribeToken, unsubscribeUrl } from "./unsubscribe.server.js";

/**
 * Digest selection, due computation, and the send flow.
 * - Due computation is per-shop local day+hour; Starter/Pro only.
 * - Period idempotency is enforced by the NotificationLog unique key
 *   (shopId, channel, kind, periodKey): a period is sent at most once.
 * - The global send budget defers (re-enqueues) over-budget sends — never
 *   drops them silently.
 */

type DigestLogger = {
  info: (o: object, m: string) => void;
  debug: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "P2002";
}

/** ISO week period key in the shop's time zone, e.g. 2026-W41. */
export function digestPeriodKey(now: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // The shop-local calendar date, shifted to UTC so the ISO math below is
  // done on the local date, not the UTC one.
  const local = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  // Canonical ISO week: move to the Thursday of that week, then count.
  const dayNum = local.getUTCDay() || 7; // Mon=1..Sun=7
  const thursday = new Date(local.getTime() + (4 - dayNum) * 86_400_000);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}


export interface DigestSelection {
  newIssues: Array<{
    id: string;
    type: string;
    severity: string;
  }>;
  totalOpen: number;
  periodKey: string;
}

interface DigestSettings {
  enabled?: boolean;
  email?: string;
  day?: number;
  hour?: number;
  skipWhenEmpty?: boolean;
}

function digestSettingsOf(shop: { settings: unknown }): DigestSettings | undefined {
  return ((shop.settings ?? {}) as { digest?: DigestSettings }).digest;
}

/** Which shops are due a digest right now (day+hour match in the shop's TZ, Starter/Pro only)? */
export async function sendDueDigests(
  now: Date,
  client: PrismaClient,
  logger: DigestLogger,
  limits: SendBudgetLimits = defaultSendBudgetLimits(),
): Promise<number> {
  const shops = await client.shop.findMany({ where: { uninstalledAt: null } });
  let enqueued = 0;
  for (const shop of shops) {
    if (enqueued >= limits.perTick) break; // smoothing: the rest are picked up next tick
    if (shop.plan === "free") continue;
    const digest = digestSettingsOf(shop);
    if (!digest?.enabled || !digest.email) continue;
    const timeZone = shop.timezone ?? "UTC";
    const day = digest.day ?? 0; // default: Monday (0 = Monday)
    const hour = digest.hour ?? 9; // default: 09:00 local
    const localNow = new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
    const localDay = DAY_NAMES.indexOf(localNow.find((p) => p.type === "weekday")?.value ?? "");
    const localHour = Number(localNow.find((p) => p.type === "hour")?.value ?? "0");
    if (localDay !== day || localHour !== hour) continue;
    const periodKey = digestPeriodKey(now, timeZone);
    const already = await client.notificationLog.count({
      where: { shopId: shop.id, channel: "email", kind: "digest", periodKey },
    });
    if (already > 0) {
      logger.debug({ shopId: shop.id, periodKey }, "digest already sent for period");
      continue;
    }
    const created = await enqueue(
      {
        kind: "digest_send",
        payload: { shopId: shop.id, periodKey },
        shopId: shop.id,
        dedupeKey: `digest:${shop.id}:${periodKey}`,
      },
      client,
    );
    // enqueue returns null when a pending duplicate already exists — only
    // genuinely new jobs consume the per-tick send budget.
    if (created) enqueued += 1;
  }
  logger.info({ enqueued }, "digest jobs enqueued");
  return enqueued;
}

/** Select digest content: issues first seen since the last digest + total open. */
export async function selectDigestContent(
  shopId: string,
  periodKey: string,
  client: PrismaClient,
  lastDigestAt: Date | null,
): Promise<DigestSelection> {
  const totalOpen = await client.issue.count({ where: { shopId, status: "open" } });
  const newIssues = await client.issue.findMany({
    where: {
      shopId,
      status: "open",
      firstSeenAt: lastDigestAt ? { gt: lastDigestAt } : undefined,
    },
    orderBy: { firstSeenAt: "desc" },
    take: 5,
    select: { id: true, type: true, severity: true },
  });
  return { newIssues, totalOpen, periodKey };
}

export type DigestSendStatus =
  | "sent"
  | "already-sent"
  | "skipped-disabled"
  | "skipped-plan"
  | "skipped-empty"
  | "deferred-budget"
  | "failed";

export interface DigestSendResult {
  status: DigestSendStatus;
  providerId?: string;
  errorCode?: string;
}

export interface DigestSendOptions {
  client?: PrismaClient;
  logger?: DigestLogger;
  now?: Date;
  transport?: EmailTransport;
  limits?: SendBudgetLimits;
  appUrl?: string;
  from?: string;
}

/**
 * The digest_send job body. Idempotent per period: the NotificationLog
 * unique key is the guard, so a retried or concurrently delivered job is a
 * no-op. Budget overflow re-enqueues for +10 minutes (deferred, not dropped).
 */
export async function runDigestSend(
  shopId: string,
  periodKey: string,
  options: DigestSendOptions = {},
): Promise<DigestSendResult> {
  const dbModule = await import("../db.server.js");
  const {
    client = dbModule.db,
    logger = { info: () => {}, debug: () => {}, warn: () => {} },
    now = new Date(),
    transport = resendTransport(env.RESEND_API_KEY),
    limits,
    appUrl = env.SHOPIFY_APP_URL,
    from = env.RESEND_FROM,
  } = options;

  const shop = await client.shop.findUnique({ where: { id: shopId } });
  if (!shop || shop.uninstalledAt) return { status: "skipped-disabled" };
  if (shop.plan === "free") return { status: "skipped-plan" };
  const digest = digestSettingsOf(shop);
  if (!digest?.enabled || !digest.email) return { status: "skipped-disabled" };

  const existing = await client.notificationLog.findFirst({
    where: { shopId, channel: "email", kind: "digest", periodKey },
  });
  if (existing && existing.status !== "failed") {
    // sent / sending / skipped_empty are terminal for this period.
    return { status: "already-sent" };
  }
  if (existing?.status === "failed") {
    // A previous attempt failed; the queue's retry/backoff drives re-sends.
    // Clear the tombstone so the unique key allows another attempt.
    await client.notificationLog.delete({ where: { id: existing.id } });
  }

  const usage = await budgetUsage(client, now, limits);
  if (usage.allowedNow < 1) {
    // Deferred, never dropped: retry next tick via a future job.
    await enqueue(
      {
        kind: "digest_send",
        payload: { shopId, periodKey },
        shopId,
        runAt: new Date(now.getTime() + 10 * 60_000),
        dedupeKey: `digest:${shopId}:${periodKey}`,
      },
      client,
    );
    logger.warn({ shopId, periodKey, usage }, "digest deferred: send budget exhausted");
    return { status: "deferred-budget" };
  }

  const selection = await selectDigestContent(shopId, periodKey, client, shop.lastDigestAt);
  if ((digest.skipWhenEmpty ?? true) && selection.newIssues.length === 0 && selection.totalOpen === 0) {
    try {
      await client.notificationLog.create({
        data: { shopId, channel: "email", kind: "digest", periodKey, status: "skipped_empty" },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { status: "already-sent" };
      throw error;
    }
    logger.debug({ shopId, periodKey }, "digest skipped: nothing new and nothing open");
    return { status: "skipped-empty" };
  }

  let logId: string;
  try {
    const created = await client.notificationLog.create({
      data: { shopId, channel: "email", kind: "digest", periodKey, status: "sending" },
    });
    logId = created.id;
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "already-sent" };
    throw error;
  }

  const locale = shop.notifyLocale ?? shop.uiLocale ?? "en";
  const token = signUnsubscribeToken({ shopId, email: digest.email });
  const unsubUrl = unsubscribeUrl(appUrl, token, locale);
  // Spec <notifications> "Links": emails use admin.shopify.com/store/<handle>/...
  // deep links into the embedded app (same builder as CSV/Telegram).
  const handle = shop.shopHandle ?? shop.shopDomain.replace(/\.myshopify\.com$/, "");
  const content = renderDigestEmail({
    locale,
    newCount: selection.newIssues.length,
    openCount: selection.totalOpen,
    issues: selection.newIssues,
    issueUrl: (id) => appPath(handle, `app/issues/${id}`),
    appUrl: appPath(handle, "app"),
    unsubscribeUrl: unsubUrl,
  });

  const result = await transport.send({
    from,
    to: digest.email,
    subject: content.subject,
    html: content.html,
    text: content.text,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "One-Click=Yes",
    },
  });

  if (result.error || !result.id) {
    const errorCode = (result.errorCode ?? "send_failed").slice(0, 200);
    await client.notificationLog.update({
      where: { id: logId },
      data: { status: "failed", errorCode },
    });
    logger.warn({ shopId, periodKey, errorCode: result.errorCode, error: result.error }, "digest send failed");
    return { status: "failed", errorCode };
  }

  await client.notificationLog.update({
    where: { id: logId },
    data: { status: "sent", providerId: result.id },
  });
  await client.shop.update({ where: { id: shopId }, data: { lastDigestAt: now } });
  logger.info({ shopId, periodKey, providerId: result.id }, "digest sent");
  return { status: "sent", providerId: result.id };
}
