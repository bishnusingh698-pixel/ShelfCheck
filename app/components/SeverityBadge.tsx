import { useI18n } from "../i18n/i18n.context";

/** Severity tone; unknown values render as info (defensive against bad rows). */
export function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useI18n();
  const tone = severity === "high" ? "critical" : severity === "medium" ? "warning" : "info";
  const icon = severity === "high" ? "!" : severity === "medium" ? "-" : "·";
  return (
    <s-badge tone={tone} aria-label={t(`issue.severity.${severity}`)}>
      <span aria-hidden="true">{icon}</span> {t(`issue.severity.${severity}`)}
    </s-badge>
  );
}
