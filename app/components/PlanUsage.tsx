import { useI18n } from "../i18n/i18n.context";
import { formatNumber } from "../i18n/format";

/** Variants analyzed versus the plan cap (spec <ui_spec> §2). */
export function PlanUsage({ analyzed, cap }: { analyzed: number; cap: number }) {
  const { t, locale } = useI18n();
  return (
    <s-section heading={t("dashboard.usage.title")}>
      <s-paragraph>
        {t("dashboard.usage.variants", {
          analyzed: formatNumber(analyzed, locale),
          cap: formatNumber(cap, locale),
        })}
      </s-paragraph>
    </s-section>
  );
}
