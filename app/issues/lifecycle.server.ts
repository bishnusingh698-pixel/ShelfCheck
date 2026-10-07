import type { PrismaClient } from "@prisma/client";
import type { DetectorResult, IssueStatus, IssueType } from "../detectors/types.js";

/**
 * Issue lifecycle: upsert (preserving snoozed/ignored/intentional),
 * resolve-absent, intentional-group regrowth, ignore-rule matching.
 *
 * Unique key per (shopId, type, variantGid, groupKey) — groupKey is "" for
 * non-grouped types so the DB key stays non-null.
 */

export interface IssueCounts {
  high: number;
  medium: number;
  low: number;
  byType: Record<string, number>;
  openTotal: number;
}

/** Upsert one detected issue, preserving manual statuses. */
export async function upsertIssue(
  shopId: string,
  scanId: string,
  finding: DetectorResult,
  client: PrismaClient,
  now = new Date(),
): Promise<"opened" | "reopened" | "unchanged" | "regrown"> {
  const groupKey = finding.groupKey ?? "";
  const existing = await client.issue.findUnique({
    where: {
      shopId_type_variantGid_groupKey: {
        shopId,
        type: finding.type,
        variantGid: finding.variantGid,
        groupKey,
      },
    },
  });

  if (!existing) {
    await client.issue.create({
      data: {
        shopId,
        type: finding.type,
        severity: finding.severity,
        variantGid: finding.variantGid,
        productGid: finding.productGid,
        groupKey,
        details: finding.details as never,
        status: "open",
        firstSeenScanId: scanId,
        lastSeenScanId: scanId,
        firstSeenAt: now,
      },
    });
    return "opened";
  }

  // Seen again this scan: update bookkeeping but NEVER clobber a manual status,
  // except: intentional groups regrow when a NEW variant joins (handled by the
  // group-level check in markIntentionalRegrowth).
  const update: Record<string, unknown> = {
    lastSeenScanId: scanId,
    severity: finding.severity,
    productGid: finding.productGid,
    // Merge details so flags set by earlier lifecycle steps (group_grew)
    // survive rescans.
    details: { ...((existing.details as Record<string, unknown>) ?? {}), ...finding.details },
  };
  if (existing.status === "resolved") {
    update.status = "open";
    update.resolvedAt = null;
    update.firstSeenScanId = scanId;
    update.firstSeenAt = now;
  }
  await client.issue.update({ where: { id: existing.id }, data: update as never });
  return existing.status === "resolved" ? "reopened" : "unchanged";
}

/**
 * Mark a duplicate group (or a single issue) as intentional. For groups, the
 * current member count is recorded as the regrowth baseline.
 */
export async function markIntentional(
  shopId: string,
  issueIds: string[],
  client: PrismaClient,
): Promise<void> {
  const issues = await client.issue.findMany({ where: { shopId, id: { in: issueIds } } });
  const groupKeys = [...new Set(issues.filter((i) => i.groupKey !== "").map((i) => i.groupKey))];
  for (const key of groupKeys) {
    const memberCount = await client.issue.count({
      where: { shopId, groupKey: key, status: { in: ["open", "snoozed", "intentional"] } },
    });
    await client.issue.updateMany({
      where: { shopId, groupKey: key, status: { in: ["open", "snoozed"] } },
      data: { status: "intentional", intentionalMemberCount: memberCount },
    });
  }
  // Single (non-group) issues marked intentional without a group.
  const singles = issues.filter((i) => i.groupKey === "");
  if (singles.length > 0) {
    await client.issue.updateMany({
      where: { shopId, id: { in: singles.map((i) => i.id) } },
      data: { status: "intentional" },
    });
  }
}

/**
 * Resolve issues that were NOT seen in the given scan. Only called after a
 * successful, non-partial scan. Open and snoozed issues are marked resolved
 * (the problem is gone). Ignored and intentional issues keep their manual
 * status; they simply stop being tracked until they reappear (upsert reopens
 * resolved rows, manual rows are never clobbered).
 */
export async function resolveAbsentIssues(
  shopId: string,
  scanId: string,
  client: PrismaClient,
  now = new Date(),
): Promise<number> {
  const result = await client.issue.updateMany({
    where: {
      shopId,
      lastSeenScanId: { not: scanId },
      status: { in: ["open", "snoozed"] as IssueStatus[] },
    },
    data: { status: "resolved", resolvedAt: now },
  });
  return result.count;
}

/** Ignore-rule matching (scope: sku | variant | product | vendor). */
export interface IgnoreRuleRow {
  scope: "sku" | "variant" | "product" | "vendor";
  value: string;
  issueType: string | null;
}

export function matchesIgnoreRules(
  finding: DetectorResult,
  row: { skuRaw: string | null; skuNorm: string | null; productGid: string; vendor: string | null },
  rules: IgnoreRuleRow[],
): boolean {
  for (const rule of rules) {
    if (rule.issueType != null && rule.issueType !== finding.type) continue;
    switch (rule.scope) {
      case "sku":
        if (row.skuNorm != null && row.skuNorm !== "" && row.skuNorm === rule.value.trim().toLowerCase()) return true;
        break;
      case "variant":
        if (finding.variantGid === rule.value) return true;
        break;
      case "product":
        if (row.productGid === rule.value) return true;
        break;
      case "vendor":
        if (row.vendor != null && row.vendor === rule.value) return true;
        break;
    }
  }
  return false;
}

/**
 * Intentional regrowth: a group marked intentional (duplicate groups only)
 * reopens ONCE when a new variant joins, with details.group_grew=true.
 * The member count recorded at marking time is the baseline.
 */
export async function markIntentionalRegrowth(
  shopId: string,
  findings: DetectorResult[],
  client: PrismaClient,
): Promise<number> {
  let regrown = 0;
  const groupKeys = [...new Set(findings.filter((f) => f.groupKey != null).map((f) => f.groupKey!))];
  for (const key of groupKeys) {
    const intentional = await client.issue.findFirst({
      where: { shopId, groupKey: key, status: "intentional" },
    });
    if (!intentional) continue;
    const currentMembers = await client.issue.count({
      where: { shopId, groupKey: key, status: { in: ["open", "intentional"] } },
    });
    const baseline = intentional.intentionalMemberCount ?? 0;
    const grewDetails = (intentional.details as Record<string, unknown> | null)?.group_grew === true;
    if (currentMembers > baseline && !grewDetails) {
      // Reopen each intentional member, MERGING details so flags like
      // case_or_space_only survive; updateMany would replace the jsonb.
      const intentionalRows = await client.issue.findMany({
        where: { shopId, groupKey: key, status: "intentional" },
      });
      for (const row of intentionalRows) {
        await client.issue.update({
          where: { id: row.id },
          data: {
            status: "open",
            details: {
              ...((row.details as Record<string, unknown>) ?? {}),
              group_grew: true,
            } as never,
          },
        });
      }
      regrown += 1;
    }
  }
  return regrown;
}

/** Aggregates for the dashboard (read from stored issues). */
export async function computeIssueCounts(
  shopId: string,
  client: PrismaClient,
): Promise<IssueCounts> {
  const open = await client.issue.findMany({
    where: { shopId, status: "open" },
    select: { severity: true, type: true },
  });
  const high = open.filter((i) => i.severity === "high").length;
  const medium = open.filter((i) => i.severity === "medium").length;
  const low = open.filter((i) => i.severity === "low").length;
  const byType: Record<string, number> = {};
  for (const i of open) {
    byType[i.type] = (byType[i.type] ?? 0) + 1;
  }
  return { high, medium, low, byType, openTotal: open.length };
}

export type { IssueType, IssueStatus };
