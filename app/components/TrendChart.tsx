import { useI18n } from "../i18n/i18n.context";
import { formatNumber } from "../i18n/format";

export interface TrendRow {
  n: number;
  opened: number;
  resolved: number;
}

/**
 * Trend of new vs resolved over the last 8 scans. The numbers are always
 * rendered as text (never color alone) and the meters only reinforce the
 * values, so screen readers get exact data.
 */
export function TrendChart({ trend }: { trend: TrendRow[] }) {
  const { t, locale } = useI18n();
  if (trend.length === 0) return null;

  const max = Math.max(1, ...trend.map((row) => Math.max(row.opened, row.resolved)));

  return (
    <s-section heading={t("dashboard.trend.title")}>
      <s-paragraph>{t("dashboard.trend.last8")}</s-paragraph>
      <s-grid gap="base">
        {trend.map((row) => {
          const label = t("dashboard.trend.scan", { n: row.n });
          return (
            <s-box key={label} padding="base">
              <s-paragraph>{label}</s-paragraph>
              <s-paragraph>
                {t("dashboard.trend.new")}: {formatNumber(row.opened, locale)}
              </s-paragraph>
              <s-paragraph>
                {t("dashboard.trend.resolved")}: {formatNumber(row.resolved, locale)}
              </s-paragraph>
              {/* Numbers are also rendered as text above, so color/tone never
                  carries the data on its own. */}
              <s-progress
                accessibilityLabel={`${label}: ${t("dashboard.trend.new")} ${row.opened}`}
                value={row.opened}
                max={max}
                tone="critical"
              ></s-progress>
              <s-progress
                accessibilityLabel={`${label}: ${t("dashboard.trend.resolved")} ${row.resolved}`}
                value={row.resolved}
                max={max}
                tone="success"
              ></s-progress>
            </s-box>
          );
        })}
      </s-grid>
    </s-section>
  );
}
