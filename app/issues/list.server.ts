import { z } from "zod";
import { Prisma } from "@prisma/client";

import type { PrismaClient } from "@prisma/client";
import { ALL_ISSUE_TYPES } from "../detectors/registry.js";
import type { IssueStatus } from "../detectors/types.js";
import { issueVisibilityLimit } from "../billing/gating.js";

/**
 * Shared issue-list query (spec <ui_spec> §3 + CSV export):
 * server-side pagination, filters (type, severity, status, vendor), search
 * by SKU or product title, sort by severity or first-seen.
 *
 * Display fields come from the variant index when the row still exists and
 * fall back to the issue's `details` snapshot (details.product_title etc.),
 * so deleted/changed variants keep rendering.
 *
 * Raw SQL with a LEFT JOIN: the search and vendor filters need columns from
 * both tables, and the COALESCE fallbacks make the filters work over the
 * same merged view the table displays.
 */

export const ISSUE_PAGE_SIZE = 25;

const STATUSES: readonly IssueStatus[] = ["open", "snoozed", "ignored", "intentional", "resolved"];

export const ISSUE_LIST_FILTER_SCHEMA = z.object({
  type: z.enum(ALL_ISSUE_TYPES as never as [string, ...string[]]).optional(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  status: z.enum(STATUSES as never as [string, ...string[]]).default("open"),
  vendor: z.string().trim().min(1).max(255).optional(),
  q: z.string().trim().max(255).optional(),
  sort: z.enum(["severity", "firstSeen"]).default("severity"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type IssueListFilters = z.infer<typeof ISSUE_LIST_FILTER_SCHEMA>;

/** Parse the URL search params into validated filters (invalid values are dropped). */
export function parseIssueFilters(url: URL): IssueListFilters {
  const raw = {
    type: url.searchParams.get("type") ?? undefined,
    severity: url.searchParams.get("severity") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    vendor: url.searchParams.get("vendor") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
  };
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const parsed = ISSUE_LIST_FILTER_SCHEMA.safeParse(cleaned);
  return parsed.success ? parsed.data : ISSUE_LIST_FILTER_SCHEMA.parse({});
}

export interface IssueListRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  groupKey: string | null;
  snoozedUntil: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  variantGid: string;
  productGid: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  vendor: string | null;
  sku: string | null;
  barcode: string | null;
  details: Record<string, unknown>;
  memberCount: number;
  isNew: boolean;
}

export interface IssueListResult {
  rows: IssueListRow[];
  total: number;
  page: number;
  pageCount: number;
  /** Rows hidden by the plan's display limit (0 when unlimited). */
  hidden: number;
  vendors: string[];
}

/** Duplicate groups are one punch-list entry per group (the spec's detail panel shows all members); count members for the badge. */
const GROUPED_TYPES = new Set(["DUPLICATE_SKU", "DUPLICATE_BARCODE"]);

interface IssueListInput {
  shopId: string;
  plan: string;
  filters: IssueListFilters;
  pageSize?: number;
}

/**
 * One page of the filtered issue list. Duplicate issues are collapsed to a
 * single row per group (the detail panel lists every member), so `total`
 * counts groups, not raw rows.
 */
export async function queryIssueList(client: PrismaClient, input: IssueListInput): Promise<IssueListResult> {
  const { shopId, filters } = input;
  const pageSize = input.pageSize ?? ISSUE_PAGE_SIZE;
  const limit = issueVisibilityLimit(input.plan); // 0 = unlimited

  const conditions: ReturnType<typeof Prisma.sql>[] = [
    Prisma.sql`i."shopId" = ${shopId}`,
    Prisma.sql`i."status" = ${filters.status}`,
  ];
  if (filters.type) conditions.push(Prisma.sql`i."type" = ${filters.type}`);
  if (filters.severity) conditions.push(Prisma.sql`i."severity" = ${filters.severity}`);
  if (filters.vendor) {
    conditions.push(
      Prisma.sql`COALESCE(v."vendor", i."details"->>'vendor') = ${filters.vendor}`,
    );
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      Prisma.sql`(
        COALESCE(v."skuRaw", i."details"->>'sku') ILIKE ${like}
        OR COALESCE(v."productTitle", i."details"->>'product_title') ILIKE ${like}
      )`,
    );
  }
  const where = Prisma.join(conditions, " AND ");

  // Groups: every member shares type + groupKey; one visible row per group
  // (the first member by the sort key). Non-grouped issues group by their id.
  const groupExpr = Prisma.sql`CASE WHEN i."groupKey" <> '' THEN i."groupKey" ELSE i."id" END`;
  const orderBy =
    filters.sort === "firstSeen"
      ? Prisma.sql`MAX(i."firstSeenAt") DESC`
      : Prisma.sql`MIN(CASE i."severity" WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END), MAX(i."firstSeenAt") DESC`;

  const rowsSql = Prisma.sql`
    SELECT * FROM (
      SELECT
        (array_agg(i."id" ORDER BY i."firstSeenAt", i."id"))[1] AS "id",
        MAX(i."type") AS "type",
        MAX(i."severity") AS "severity",
        MAX(i."status") AS "status",
        MAX(i."groupKey") AS "groupKey",
        MAX(i."snoozedUntil") AS "snoozedUntil",
        MIN(i."firstSeenAt") AS "firstSeenAt",
        MAX(COALESCE(ls."finishedAt", ls."startedAt", i."firstSeenAt")) AS "lastSeenAt",
        (array_agg(i."variantGid" ORDER BY i."firstSeenAt", i."id"))[1] AS "variantGid",
        MAX(i."productGid") AS "productGid",
        COUNT(*)::int AS "memberCount",
        MIN(CASE WHEN i."groupKey" <> '' THEN 0 ELSE 1 END) AS "isGroup"
      FROM "Issue" i
      LEFT JOIN "VariantIndex" v ON v."shopId" = i."shopId" AND v."variantGid" = i."variantGid"
      LEFT JOIN "Scan" ls ON ls."id" = i."lastSeenScanId"
      WHERE ${where}
      GROUP BY ${groupExpr}, i."type"
      ORDER BY ${orderBy}
    ) g
  `;

  // Count groups (the same GROUP BY) for pagination, honoring the plan cap.
  const totalRes = await client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS count FROM (
      SELECT ${groupExpr} AS "gk", i."type"
      FROM "Issue" i
      LEFT JOIN "VariantIndex" v ON v."shopId" = i."shopId" AND v."variantGid" = i."variantGid"
      WHERE ${where}
      GROUP BY ${groupExpr}, i."type"
    ) g
  `);
  const totalAll = Number(totalRes[0]?.count ?? 0);
  const capped = limit > 0 ? Math.min(totalAll, limit) : totalAll;
  const hidden = limit > 0 ? Math.max(0, totalAll - limit) : 0;

  const page = Math.min(filters.page, Math.max(1, Math.ceil(capped / pageSize)));
  const offset = (page - 1) * pageSize;
  const groups = await client.$queryRaw<
    Array<{
      id: string;
      type: string;
      severity: string;
      status: string;
      groupKey: string;
      snoozedUntil: Date | null;
      firstSeenAt: Date;
      lastSeenAt: Date;
      variantGid: string;
      productGid: string | null;
      memberCount: number;
    }>
  >(Prisma.sql`${rowsSql} LIMIT ${pageSize} OFFSET ${offset}`);

  // Display fields for the page's rows: merged variant-index snapshot +
  // details fallback (issues for deleted variants still render).
  const ids = groups.map((g) => g.id);
  const rawRows = ids.length
    ? await client.issue.findMany({ where: { shopId, id: { in: ids } } })
    : [];
  const variantGids = groups.map((g) => g.variantGid);
  const variants = variantGids.length
    ? await client.variantIndex.findMany({ where: { shopId, variantGid: { in: variantGids } } })
    : [];
  const rawById = new Map(rawRows.map((r) => [r.id, r]));
  const variantByGid = new Map(variants.map((v) => [v.variantGid, v]));
  const latestScan = await client.scan.findFirst({
    where: { shopId, status: "completed" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  const rows: IssueListRow[] = groups.map((g) => {
    const raw = rawById.get(g.id);
    const variant = variantByGid.get(g.variantGid);
    const details = (raw?.details ?? {}) as Record<string, unknown>;
    return {
      id: g.id,
      type: g.type,
      severity: g.severity,
      status: g.status,
      groupKey: g.groupKey === "" ? null : g.groupKey,
      snoozedUntil: g.snoozedUntil ? g.snoozedUntil.toISOString() : null,
      firstSeenAt: g.firstSeenAt.toISOString(),
      lastSeenAt: g.lastSeenAt.toISOString(),
      variantGid: g.variantGid,
      productGid: raw?.productGid ?? g.productGid ?? null,
      productTitle: variant?.productTitle ?? str(details.product_title),
      variantTitle: variant?.variantTitle ?? str(details.variant_title),
      vendor: variant?.vendor ?? str(details.vendor),
      sku: variant?.skuRaw ?? str(details.sku),
      barcode: variant?.barcode ?? str(details.barcode),
      details,
      memberCount: g.memberCount,
      isNew: raw != null && raw.firstSeenScanId != null && raw.firstSeenScanId === latestScan?.id,
    };
  });

  // Vendor filter options from the same merged view the rows display:
  // variant-index vendors plus the details fallback (deleted variants).
  const vendorsRes = await client.$queryRaw<Array<{ vendor: string }>>(Prisma.sql`
    SELECT DISTINCT vendor FROM (
      SELECT v."vendor" AS vendor
      FROM "VariantIndex" v
      WHERE v."shopId" = ${shopId} AND v."vendor" IS NOT NULL AND v."vendor" <> ''
      UNION
      SELECT i."details"->>'vendor' AS vendor
      FROM "Issue" i
      WHERE i."shopId" = ${shopId} AND i."details"->>'vendor' IS NOT NULL AND i."details"->>'vendor' <> ''
    ) u
    ORDER BY vendor
    LIMIT 200
  `);

  return {
    rows,
    total: capped,
    page,
    pageCount: Math.max(1, Math.ceil(capped / pageSize)),
    hidden,
    vendors: vendorsRes.map((v) => v.vendor),
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** True when the issue type forms duplicate groups (members share groupKey). */
export function isGroupedType(type: string): boolean {
  return GROUPED_TYPES.has(type);
}
