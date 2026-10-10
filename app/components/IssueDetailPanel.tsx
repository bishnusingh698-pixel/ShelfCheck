import { useState } from "react";
import { Link, useActionData, useSubmit } from "react-router";

import { useI18n } from "../i18n/i18n.context";
import { formatDate } from "../i18n/format";
import { SeverityBadge } from "./SeverityBadge.js";
import { UndoToast } from "./UndoToast.js";
import { issueDetailText } from "../issues/detail-text.js";
import { SNOOZE_DAYS } from "../issues/snooze.js";

/**
 * Issue / duplicate-group detail panel (spec <ui_spec> §3): group members
 * with product, variant, an "Open in Shopify admin" link and a copy-SKU
 * button; single-issue actions with undo.
 */

export interface DetailIssue {
  id: string;
  type: string;
  severity: string;
  status: string;
  groupKey: string | null;
  snoozedUntil: string | null;
  firstSeenAt: string;
  lastSeenScanId: string | null;
  intentionalMemberCount: number | null;
  details: Record<string, unknown>;
}

export interface DetailMember {
  issueId: string;
  variantGid: string;
  productGid: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  vendor: string | null;
  status: string;
  adminUrl: string | null;
}

export function IssueDetailPanel({ issue, members }: { issue: DetailIssue; members: DetailMember[] }) {
  const { t, locale } = useI18n();
  const submit = useSubmit();
  const actionData = useActionData<{ toast?: string; undo?: { id: string; from: string } | null }>();
  const [snoozeDays, setSnoozeDays] = useState<number>(7);
  const [copied, setCopied] = useState<string | null>(null);

  const act = (intent: string, extra?: Record<string, string>) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    submit(fd, { method: "post" });
  };

  const copySku = async (sku: string, key: string) => {
    try {
      await navigator.clipboard.writeText(sku);
      setCopied(key);
    } catch {
      setCopied(null); // clipboard denied: the SKU stays selectable in the table
    }
  };

  return (
    <s-page heading={t(`issue.type.${issue.type}`)}>
      {actionData?.toast && (
        <UndoToast
          message={actionData.toast}
          onUndo={
            actionData.undo
              ? () => act("restore", { from: actionData.undo!.from })
              : undefined
          }
        />
      )}

      <s-section>
        <s-stack gap="base">
          <SeverityBadge severity={issue.severity} />
          <s-badge>{t(`issue.status.${issue.status}`)}</s-badge>
          <s-paragraph>
            {issueDetailText(t, { type: issue.type, details: issue.details })}
          </s-paragraph>
          <s-paragraph>
            {t("issue.list.sortFirstSeen")}: {formatDate(new Date(issue.firstSeenAt), locale, "UTC")}
          </s-paragraph>
          {issue.snoozedUntil && (
            <s-banner tone="info">
              {t("issue.snooze.banner", { date: formatDate(new Date(issue.snoozedUntil), locale, "UTC") })}
            </s-banner>
          )}
          <s-stack direction="inline" gap="base">
            {issue.status === "snoozed" ? (
              <s-button variant="secondary" onClick={() => act("unsnooze")}>
                {t("issue.actions.unsnooze")}
              </s-button>
            ) : (
              <>
                <label htmlFor="snooze-days">{t("issue.actions.snooze")}</label>
                <select
                  id="snooze-days"
                  value={snoozeDays}
                  onChange={(e) => setSnoozeDays(Number((e.target as HTMLSelectElement).value))}
                >
                  {SNOOZE_DAYS.map((d) => (
                    <option key={d} value={d}>
                      {t("issue.snooze.days", { count: d })}
                    </option>
                  ))}
                </select>
                <s-button variant="secondary" onClick={() => act("snooze", { days: String(snoozeDays) })}>
                  {t("issue.actions.snooze")}
                </s-button>
              </>
            )}
            <s-button variant="secondary" onClick={() => act("ignore")}>
              {t("issue.actions.ignore")}
            </s-button>
            <s-button variant="secondary" onClick={() => act("intentional")}>
              {t("issue.actions.intentional")}
            </s-button>
            <s-button variant="secondary" onClick={() => act("resolve")}>
              {t("issue.actions.resolve")}
            </s-button>
          </s-stack>
          <Link to="/app/issues">{t("issue.list.title")}</Link>
        </s-stack>
      </s-section>

      {members.length > 1 && (
        <s-section heading={t("issue.list.groupMembers")}>
          <s-table variant="list">
            <s-table-header>
              <s-table-header-row>
                <s-table-header>{t("rules.value")}</s-table-header>
                <s-table-header>{t("issue.list.filterVendor")}</s-table-header>
                <s-table-header>{t("issue.list.filterStatus")}</s-table-header>
                <s-table-header>{t("common.openInAdmin")}</s-table-header>
              </s-table-header-row>
            </s-table-header>
            <s-table-body>
              {members.map((m) => (
                <s-table-row key={m.issueId}>
                  <s-table-cell>
                    <s-paragraph>{m.productTitle ?? "—"}</s-paragraph>
                    <s-paragraph>{m.variantTitle ?? ""}</s-paragraph>
                    {m.sku && (
                      <>
                        <s-paragraph>{m.sku}</s-paragraph>
                        <s-button variant="secondary" onClick={() => void copySku(m.sku!, m.issueId)}>
                          {copied === m.issueId ? t("common.copied") : t("common.copySku")}
                        </s-button>
                      </>
                    )}
                  </s-table-cell>
                  <s-table-cell>{m.vendor ?? "—"}</s-table-cell>
                  <s-table-cell>{t(`issue.status.${m.status}`)}</s-table-cell>
                  <s-table-cell>
                    {m.adminUrl && (
                      <s-link href={m.adminUrl} target="_blank">
                        {t("common.openInAdmin")}
                      </s-link>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
