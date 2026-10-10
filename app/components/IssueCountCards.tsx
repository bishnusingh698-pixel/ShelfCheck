import { Link } from "react-router";
import { useI18n } from "../i18n/i18n.context";
import { formatNumber } from "../i18n/format";

export interface CountCardsData {
  high: number;
  medium: number;
  low: number;
  byType: Record<string, number>;
}

/**
 * Counts by severity and type. Every number links to the issues list with
 * the matching filter pre-applied (spec <ui_spec> §2). Links use the
 * template's Link component — never raw <a>.
 */
export function IssueCountCards({ counts, showByType }: { counts: CountCardsData; showByType: boolean }) {
  const { t, locale } = useI18n();

  const severityRows = [
    { key: "high", value: counts.high, filter: "severity=high" },
    { key: "medium", value: counts.medium, filter: "severity=medium" },
    { key: "low", value: counts.low, filter: "severity=low" },
  ];

  return (
    <s-section heading={t("dashboard.counts.title")}>
      <s-grid gap="base" grid-template-columns="1fr 1fr 1fr">
        {severityRows.map((row) => (
          <s-box key={row.key} padding="base">
            <s-heading>{formatNumber(row.value, locale)}</s-heading>
            <Link to={`/app/issues?${row.filter}`}>{t(`issue.severity.${row.key}`)}</Link>
          </s-box>
        ))}
      </s-grid>
      {showByType && Object.keys(counts.byType).length > 0 && (
        <>
          <s-heading>{t("dashboard.counts.byType")}</s-heading>
          <s-grid gap="base">
            {Object.entries(counts.byType).map(([type, value]) => (
              <s-box key={type} padding="base">
                <s-paragraph>{formatNumber(value, locale)}</s-paragraph>
                <Link to={`/app/issues?type=${type}`}>{t(`issue.type.${type}`)}</Link>
              </s-box>
            ))}
          </s-grid>
        </>
      )}
    </s-section>
  );
}
