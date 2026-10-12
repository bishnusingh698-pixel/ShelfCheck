import { useI18n } from "../i18n/i18n.context";
import type { SinceLastVisitSummary } from "../activity/queries.server";

/**
 * Dashboard card (spec <in_app_alerts> "Since-last-visit card"): how many
 * new issues, resolutions, and scans happened since the merchant's last
 * visit. Each line links to the matching filtered view; "Mark all as seen"
 * moves the activity_seen_at marker.
 */
export function SinceLastVisitCard({
  summary,
  onMarkSeen,
  marking,
}: {
  summary: SinceLastVisitSummary;
  onMarkSeen: () => void;
  marking: boolean;
}) {
  const { t } = useI18n();
  const nothingNew =
    summary.newIssues === 0 &&
    summary.resolvedIssues === 0 &&
    summary.scansFinished === 0 &&
    summary.scansFailed === 0 &&
    (summary.scoreDelta === null || summary.scoreDelta === 0);

  return (
    <s-section heading={t("dashboard.sinceLastVisit.title")}>
      {nothingNew ? (
        <p>{t("dashboard.sinceLastVisit.nothingNew")}</p>
      ) : (
        <s-stack gap="base">
          <ul>
            <li>
              <s-link href="/app/issues?newOnly=1&status=open">
                {t("dashboard.sinceLastVisit.newIssues", {
                  count: summary.newIssues,
                  high: summary.newHighIssues,
                })}
              </s-link>
            </li>
            <li>
              <s-link href="/app/issues?status=resolved">
                {t("dashboard.sinceLastVisit.resolvedIssues", { count: summary.resolvedIssues })}
              </s-link>
            </li>
            {summary.scansFinished > 0 && (
              <li>
                <s-link href="/app/activity?kind=scan_completed">
                  {t("dashboard.sinceLastVisit.scansFinished", { count: summary.scansFinished })}
                </s-link>
              </li>
            )}
            {summary.scansFailed > 0 && (
              <li>
                <s-link href="/app/activity?kind=scan_failed">
                  {t("dashboard.sinceLastVisit.scansFailed", { count: summary.scansFailed })}
                </s-link>
              </li>
            )}
            {summary.scoreDelta != null && summary.scoreDelta !== 0 && (
              <li>
                <s-link href="/app/activity?kind=scan_completed">
                  {t("dashboard.sinceLastVisit.scoreChange", { delta: summary.scoreDelta })}
                </s-link>
              </li>
            )}
          </ul>
          <s-button type="button" onClick={onMarkSeen} disabled={marking}>
            {t("dashboard.sinceLastVisit.markSeen")}
          </s-button>
        </s-stack>
      )}
    </s-section>
  );
}
