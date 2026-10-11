import type { LoaderFunctionArgs } from "react-router";

import { db } from "../db.server.js";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { rateLimit } from "../lib/rate-limit.server.js";
import { makeT } from "../i18n/i18n.server.js";
import { resolveLocale } from "../i18n/resolve-locale.js";
import { csvExportRows } from "../billing/gating.js";
import { parseIssueFilters, queryIssueList } from "../issues/list.server.js";
import { issueDetailText } from "../issues/detail-text.js";
import { CSV_BOM, CSV_COLUMNS, csvRow } from "../csv/escape.js";
import { productAdminPath } from "../lib/admin-urls.js";

/**
 * CSV export resource route (spec <ui_spec> §7): exports the CURRENT
 * filtered open list (the filters come from the issues screen's query
 * string). RFC 4180 escaping + formula-injection neutralization are applied
 * by csv/escape.ts; the file starts with a UTF-8 BOM; the row count is
 * capped by the plan (free: 50 rows/week-equivalent per plan table).
 */

const EXPORT_RATE_LIMIT = 4;
const EXPORT_WINDOW_MS = 60_000;

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);

  const limit = await rateLimit(`csv-export:${shop.id}`, EXPORT_RATE_LIMIT, EXPORT_WINDOW_MS);
  if (!limit.allowed) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }

  const filters = parseIssueFilters(new URL(request.url));
  const list = await queryIssueList(db, {
    shopId: shop.id,
    plan: shop.plan,
    filters,
    pageSize: 5_000,
  });

  const cap = csvExportRows(shop.plan); // 0 = unlimited
  const rows = cap > 0 ? list.rows.slice(0, cap) : list.rows;

  const t = makeT(resolveLocale(shop.uiLocale));
  const handle = shop.shopHandle ?? shop.shopDomain.replace(/\.myshopify\.com$/, "");
  const iso = (value: string) => value;

  const lines = [csvRow([...CSV_COLUMNS])];
  for (const row of rows) {
    lines.push(
      csvRow([
        row.type,
        row.severity,
        row.status,
        row.productGid ?? "",
        row.productTitle ?? "",
        row.variantGid,
        row.variantTitle ?? "",
        row.sku ?? "",
        row.barcode ?? "",
        row.vendor ?? "",
        issueDetailText(t, row),
        row.groupKey ?? "",
        row.productGid ? productAdminPath(handle, row.productGid) : "",
        iso(row.firstSeenAt),
        iso(row.lastSeenAt),
      ]),
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  return new Response(CSV_BOM + lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="shelfcheck-issues-${date}.csv"`,
    },
  });
}
