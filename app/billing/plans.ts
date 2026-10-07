/**
 * Plan definitions and limits (pure). Plans are configured in Shopify Managed
 * Pricing; the app only READS currentAppInstallation.activeSubscriptions to map
 * a shop to a plan. Never trust client-side plan claims.
 */

export type PlanId = "free" | "starter" | "pro";

export interface PlanLimits {
  id: PlanId;
  labelKey: string;
  /** Manual scans per rolling day (shop time zone). */
  manualScansPerDay: number;
  /** Scheduled scan cadence. */
  scheduled: "monthly" | "weekly" | "daily";
  /** Issues visible in the UI. 0 = unlimited. */
  issueVisibilityLimit: number;
  /** Max variants analyzed per scan. */
  variantCap: number;
  webhookWatchers: boolean;
  emailDigest: boolean;
  csvExportRows: number;
  autoTag: boolean;
  telegram: boolean;
  scanCooldownMinutes: number;
  trialDays: number | null;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    labelKey: "plans.free.name",
    manualScansPerDay: 0,
    scheduled: "monthly",
    issueVisibilityLimit: 50,
    variantCap: 500,
    webhookWatchers: false,
    emailDigest: false,
    csvExportRows: 50,
    autoTag: false,
    telegram: false,
    scanCooldownMinutes: 0,
    trialDays: null,
  },
  starter: {
    id: "starter",
    labelKey: "plans.starter.name",
    manualScansPerDay: 3,
    scheduled: "weekly",
    issueVisibilityLimit: 0,
    variantCap: 5_000,
    webhookWatchers: true,
    emailDigest: true,
    csvExportRows: 0,
    autoTag: false,
    telegram: false,
    scanCooldownMinutes: 10,
    trialDays: 7,
  },
  pro: {
    id: "pro",
    labelKey: "plans.pro.name",
    manualScansPerDay: 10,
    scheduled: "daily",
    issueVisibilityLimit: 0,
    variantCap: 50_000,
    webhookWatchers: true,
    emailDigest: true,
    csvExportRows: 0,
    autoTag: true,
    telegram: true,
    scanCooldownMinutes: 10,
    trialDays: 7,
  },
};

export function planLimits(plan: string): PlanLimits {
  if (plan === "starter" || plan === "pro") return PLANS[plan];
  return PLANS.free;
}
