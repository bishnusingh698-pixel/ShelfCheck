import { planLimits } from "./plans.js";

/**
 * Pure plan-gating checks. Inputs only; no I/O. Tested exhaustively.
 */

export interface ScanGatingInput {
  plan: string;
  lastScanAt: Date | null;
  scansToday: number;
}

export type ScanTrigger = "manual" | "scheduled" | "install";

export interface GatingDecision {
  allowed: boolean;
  reason?: "free-plan-monthly" | "daily-limit" | "cooldown";
}

/** Can the shop start a scan right now? */
export function canScanNow(input: ScanGatingInput, trigger: ScanTrigger, now: Date): GatingDecision {
  const limits = planLimits(input.plan);

  // Install scans always run: onboarding must work on every plan.
  if (trigger !== "install") {
    if (input.plan === "free" && trigger === "manual") {
      return { allowed: false, reason: "free-plan-monthly" };
    }
    if (input.plan === "free" && trigger === "scheduled") {
      // Free scheduled (monthly) scans are allowed, subject to nothing else here;
      // the scheduler already ensures one per calendar month.
    } else if (trigger === "manual" && input.scansToday >= limits.manualScansPerDay) {
      return { allowed: false, reason: "daily-limit" };
    }
    if (limits.scanCooldownMinutes > 0 && input.lastScanAt) {
      const elapsedMs = now.getTime() - input.lastScanAt.getTime();
      if (elapsedMs < limits.scanCooldownMinutes * 60_000) {
        return { allowed: false, reason: "cooldown" };
      }
    }
  }
  return { allowed: true };
}

export function issueVisibilityLimit(plan: string): number {
  return planLimits(plan).issueVisibilityLimit;
}

export function variantCap(plan: string): number {
  return planLimits(plan).variantCap;
}

export function featureEnabled(plan: string, feature: "watchers" | "digest" | "autoTag" | "telegram"): boolean {
  const limits = planLimits(plan);
  switch (feature) {
    case "watchers":
      return limits.webhookWatchers;
    case "digest":
      return limits.emailDigest;
    case "autoTag":
      return limits.autoTag;
    case "telegram":
      return limits.telegram;
  }
}

export function csvExportRows(plan: string): number {
  return planLimits(plan).csvExportRows;
}

/** True when a shop is over the variant cap after a scan. */
export function isOverCap(plan: string, variantsSeen: number): boolean {
  return variantsSeen > variantCap(plan);
}
