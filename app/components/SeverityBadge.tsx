import { useI18n } from "../i18n/i18n.context";

/** Severity as text badge with an icon — never color alone (WCAG 2.1 AA). */
export function SeverityBadge({ severity }: { severity: "high" | "medium" | "low" }) {
  const { t } = useI18n();
  const tone = severity === "high" ? "critical" : severity === "medium" ? "warning" : "info";
  const icon = severity === "high" ? "!" : severity === "medium" ? "-" : "·";
  return (
    <s-badge tone={tone} aria-label={t(`issue.severity.${severity}`)}>
      <span aria-hidden="true">{icon}</span> {t(`issue.severity.${severity}`)}
    </s-badge>
  );
}
