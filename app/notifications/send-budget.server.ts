import type { PrismaClient } from "@prisma/client";
import { env } from "../env.server.js";

/**
 * Global email send budget (spec <notifications>):
 * - keeps total sends under the Resend daily and monthly limits,
 * - smooths sends per tick so one cron fire cannot blow the day's budget,
 * - excess sends are deferred (the job is re-enqueued with a future runAt),
 *   never dropped silently.
 *
 * Accounting counts NotificationLog rows with channel="email" and
 * status="sent" (UTC calendar windows). The counter is monotone and the
 * tick drains jobs sequentially, so count-then-send is race-free enough:
 * the worst case under concurrent ticks is one extra send, still inside the
 * Resend daily limit because per-tick smoothing caps the blast radius.
 */

export interface SendBudgetLimits {
  dailyLimit: number;
  monthlyLimit: number;
  /** Max digest jobs a single tick may enqueue (smoothing). */
  perTick: number;
}

export function defaultSendBudgetLimits(): SendBudgetLimits {
  const dailyLimit = env.RESEND_DAILY_LIMIT;
  return {
    dailyLimit,
    monthlyLimit: env.RESEND_MONTHLY_LIMIT,
    perTick: Math.max(1, Math.ceil(dailyLimit / 24)),
  };
}

export interface BudgetUsage {
  sentToday: number;
  sentThisMonth: number;
  allowedToday: number;
  allowedThisMonth: number;
  allowedNow: number;
}

export async function budgetUsage(
  client: PrismaClient,
  now: Date = new Date(),
  limits: SendBudgetLimits = defaultSendBudgetLimits(),
): Promise<BudgetUsage> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [sentToday, sentThisMonth] = await Promise.all([
    client.notificationLog.count({
      where: { channel: "email", status: "sent", sentAt: { gte: dayStart } },
    }),
    client.notificationLog.count({
      where: { channel: "email", status: "sent", sentAt: { gte: monthStart } },
    }),
  ]);
  const allowedToday = Math.max(0, limits.dailyLimit - sentToday);
  const allowedThisMonth = Math.max(0, limits.monthlyLimit - sentThisMonth);
  return { sentToday, sentThisMonth, allowedToday, allowedThisMonth, allowedNow: Math.min(allowedToday, allowedThisMonth) };
}
