import { Link } from "react-router";
import { useI18n } from "../i18n/i18n.context";

/** Over-cap warning with the upgrade link (spec <ui_spec> §2). */
export function OverCapBanner({ overCapCount }: { overCapCount: number }) {
  const { t } = useI18n();
  if (overCapCount <= 0) return null;
  return (
    <s-banner tone="warning" heading={t("dashboard.usage.overCap", { count: overCapCount })}>
      <s-paragraph>{t("dashboard.usage.overCapNote")}</s-paragraph>
      <Link to="/app/plans">{t("dashboard.usage.upgrade")}</Link>
    </s-banner>
  );
}
