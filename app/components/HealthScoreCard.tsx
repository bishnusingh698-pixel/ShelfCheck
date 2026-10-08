import { useI18n } from "../i18n/i18n.context";

/**
 * Health score band: excellent >= 90, good >= 75, needs attention >= 50,
 * critical below. The band word is always rendered as text next to the
 * number (WCAG: severity never conveyed by color alone); the tone only
 * reinforces it.
 */
export function healthBand(score: number): "excellent" | "good" | "needs_attention" | "critical" {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 50) return "needs_attention";
  return "critical";
}

export function HealthScoreCard({ score }: { score: number | null }) {
  const { t } = useI18n();

  const band = score == null ? null : healthBand(score);
  const tone =
    band == null || band === "excellent" || band === "good" ? "success" : band === "needs_attention" ? "warning" : "critical";

  return (
    <s-section heading={t("dashboard.healthScore")}>
      <s-heading>{score == null ? "—" : score}</s-heading>
      {band && (
        <s-badge tone={tone} icon="status">
          {t(`dashboard.band.${band}`)}
        </s-badge>
      )}
    </s-section>
  );
}
