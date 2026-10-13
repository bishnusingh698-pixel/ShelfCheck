import { useI18n } from "../i18n/i18n.context";
import type { WeeklySummary } from "../activity/queries.server";

/**
 * "This week" card (spec <in_app_alerts>): new vs. resolved issue counts
 * compared with last week and the health-score trend. Starter and Pro only.
 */
export function WeeklySummaryCard({ summary }: { summary: WeeklySummary }) {
  const { t } = useI18n();
  return (
    <s-section heading={t("dashboard.weeklySummary.title")}>
      <s-stack gap="base">
        <p>
          {t("dashboard.weeklySummary.newIssues", {
            count: summary.newThisWeek,
            last: summary.newLastWeek,
          })}
        </p>
        <p>
          {t("dashboard.weeklySummary.resolvedIssues", {
            count: summary.resolvedThisWeek,
            last: summary.resolvedLastWeek,
          })}
        </p>
        {summary.scoreDelta != null && summary.scoreDelta !== 0 && (
          <p>
            {t("dashboard.weeklySummary.scoreChange", {
              direction: t(
                summary.scoreDelta > 0
                  ? "dashboard.weeklySummary.improved"
                  : "dashboard.weeklySummary.declined",
              ),
              delta: Math.abs(summary.scoreDelta),
            })}
          </p>
        )}
      </s-stack>
    </s-section>
  );
}
