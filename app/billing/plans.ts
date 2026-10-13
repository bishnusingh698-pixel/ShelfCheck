/**
 * Plan definitions and limits (pure). Plans are configured in Shopify App
 * Pricing (formerly Managed Pricing) in the Partner Dashboard; the app only
 * READS currentAppInstallation.activeSubscriptions to map a shop to a plan.
 * Never trust client-side plan claims.
 *
 * Prices are in USD and displayed in USD everywhere (spec
 * <plans_and_limits>): they are never converted to the shop's currency.
 * Prices live ONLY in this module.
 */

export type PlanId = "free" | "starter" | "pro";

export interface PlanLimits {
  id: PlanId;
  labelKey: string;
  /** USD price per month. Free = 0. The only place prices appear in code. */
  priceUsd: number;
  /** Trial days from Shopify App Pricing (null for Free). */
  trialDays: number | null;
  /** Manual scans per rolling day (shop time zone). */
  manualScansPerDay: number;
  /** Scheduled scan cadence. */
  scheduled: "monthly" | "weekly" | "daily";
  /** Issues visible in the UI. 0 = unlimited. */
  issueVisibilityLimit: number;
  /** Max variants analyzed per scan. */
  variantCap: number;
  webhookWatchers: boolean;
  /** Weekly summary card (Starter and Pro only). */
  weeklySummary: boolean;
  /** Days of activity history shown. Data is kept 90 days regardless. */
  activityHistoryDays: number;
  /** Max rows in CSV export. 0 = unlimited. */
  csvExportRows: number;
  autoTag: boolean;
  /** Minutes between scans (Starter/Pro manual cooldown). */
  scanCooldownMinutes: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    labelKey: "plans.free.name",
    priceUsd: 0,
    trialDays: null,
    manualScansPerDay: 0,
    scheduled: "monthly",
    issueVisibilityLimit: 50,
    variantCap: 500,
    webhookWatchers: false,
    weeklySummary: false,
    activityHistoryDays: 7,
    csvExportRows: 50,
    autoTag: false,
    scanCooldownMinutes: 0,
  },
  starter: {
    id: "starter",
    labelKey: "plans.starter.name",
    priceUsd: 4.99,
    trialDays: 7,
    manualScansPerDay: 3,
    scheduled: "weekly",
    issueVisibilityLimit: 0,
    variantCap: 5_000,
    webhookWatchers: true,
    weeklySummary: true,
    activityHistoryDays: 30,
    csvExportRows: 0,
    autoTag: false,
    scanCooldownMinutes: 10,
  },
  pro: {
    id: "pro",
    labelKey: "plans.pro.name",
    priceUsd: 9.99,
    trialDays: 7,
    manualScansPerDay: 10,
    scheduled: "daily",
    issueVisibilityLimit: 0,
    variantCap: 50_000,
    webhookWatchers: true,
    weeklySummary: true,
    activityHistoryDays: 90,
    csvExportRows: 0,
    autoTag: true,
    scanCooldownMinutes: 10,
  },
};

export function planLimits(plan: string): PlanLimits {
  if (plan === "starter" || plan === "pro") return PLANS[plan];
  return PLANS.free;
}
