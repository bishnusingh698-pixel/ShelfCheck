import { useState } from "react";
import { Link, useSubmit } from "react-router";

import { useI18n } from "../i18n/i18n.context";
import { formatNumber } from "../i18n/format";
import { SeverityBadge } from "./SeverityBadge.js";
import { issueDetailText } from "../issues/detail-text.js";
import type { IssueListRow } from "../issues/list.server.js";

/**
 * Server-paginated issue table (spec <ui_spec> §3). Bulk actions submit to
 * the route action (snooze/ignore/intentional) and the route returns the
 * undo payload rendered by UndoToast. Duplicate groups collapse to one row
 * with a member count; the row links to the detail panel.
 */

export interface IssueTableProps {
  rows: IssueListRow[];
  page: number;
  pageCount: number;
  total: number;
  hrefForPage: (page: number) => string;
  exportHref: string;
}

export function IssueTable({ rows, page, pageCount, total, hrefForPage, exportHref }: IssueTableProps) {
  const { t, locale } = useI18n();
  const submit = useSubmit();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const bulkSubmit = (intent: string, days?: number) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const id of selected) fd.append("ids", id);
    if (days) fd.set("days", String(days));
    submit(fd, { method: "post" });
    setSelected(new Set());
  };

  const rowAction = (id: string, intent: string) => {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.append("ids", id);
    submit(fd, { method: "post" });
  };

  const pageHref = (n: number) => hrefForPage(n);

  return (
    <s-section>
      <s-stack gap="base">
        <s-box padding="base">
          <s-paragraph>{t("issue.list.selected", { count: selected.size })}</s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button variant="secondary" disabled={selected.size === 0} onClick={() => bulkSubmit("snooze", 7)}>
              {t("issue.list.bulkSnooze")}
            </s-button>
            <s-button variant="secondary" disabled={selected.size === 0} onClick={() => bulkSubmit("ignore")}>
              {t("issue.list.bulkIgnore")}
            </s-button>
            <s-button variant="secondary" disabled={selected.size === 0} onClick={() => bulkSubmit("intentional")}>
              {t("issue.list.bulkIntentional")}
            </s-button>
          </s-stack>
        </s-box>

        <s-table variant="list">
          <s-table-header>
            <s-table-header-row>
              <s-table-header>
                <input
                  type="checkbox"
                  aria-label={t("issue.list.selected", { count: rows.length })}
                  checked={allSelected}
                  onChange={(e) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set());
                  }}
                />
              </s-table-header>
              <s-table-header>{t("issue.list.filterSeverity")}</s-table-header>
              <s-table-header>{t("issue.list.filterType")}</s-table-header>
              <s-table-header>{t("rules.value")}</s-table-header>
              <s-table-header>{t("issue.list.filterVendor")}</s-table-header>
              <s-table-header>{t("issue.list.actions")}</s-table-header>
            </s-table-header-row>
          </s-table-header>
          <s-table-body>
            {rows.map((row) => {
              const detail = issueDetailText(t, row);
              return (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <input
                      type="checkbox"
                      aria-label={row.productTitle ?? row.sku ?? row.id}
                      checked={selected.has(row.id)}
                      onChange={(e) => toggle(row.id, (e.target as HTMLInputElement).checked)}
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <SeverityBadge severity={row.severity} />
                    {row.isNew && <s-badge tone="info">{t("issue.list.newBadge")}</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    <Link to={`/app/issues/${row.id}`}>{t(`issue.type.${row.type}`)}</Link>
                    {detail && <s-paragraph>{detail}</s-paragraph>}
                    {row.memberCount > 1 && (
                      <s-paragraph>{t("issue.list.groupMembers")}</s-paragraph>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-paragraph>{row.sku ?? "—"}</s-paragraph>
                    <s-paragraph>{row.productTitle ?? "—"}</s-paragraph>
                    <s-paragraph>{row.variantTitle ?? ""}</s-paragraph>
                  </s-table-cell>
                  <s-table-cell>{row.vendor ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base">
                      {row.status === "snoozed" ? (
                        <s-button variant="secondary" onClick={() => rowAction(row.id, "unsnooze")}>
                          {t("issue.actions.unsnooze")}
                        </s-button>
                      ) : (
                        <s-button variant="secondary" onClick={() => rowAction(row.id, "resolve")}>
                          {t("issue.actions.resolve")}
                        </s-button>
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>

        <s-stack direction="inline" gap="base">
          {page > 1 && (
            <Link to={pageHref(page - 1)}>
              <s-button variant="secondary">{t("issue.list.previous")}</s-button>
            </Link>
          )}
          <s-paragraph>{t("issue.list.pageStatus", { page, pageCount, total: formatNumber(total, locale) })}</s-paragraph>
          {page < pageCount && (
            <Link to={pageHref(page + 1)}>
              <s-button variant="secondary">{t("issue.list.next")}</s-button>
            </Link>
          )}
          <Link to={exportHref}>
            <s-button variant="secondary">{t("csv.export")}</s-button>
          </Link>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
