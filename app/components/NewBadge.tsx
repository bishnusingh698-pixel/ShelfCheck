import { useI18n } from "../i18n/i18n.context";

/**
 * "New" badge for issues first seen after the merchant's last visit
 * (spec <ui_spec> issues list). Pure: callers pass the comparison result.
 */
export function NewBadge({ isNew }: { isNew: boolean }) {
  const { t } = useI18n();
  if (!isNew) return null;
  return <s-badge tone="info">{t("issue.list.newBadge")}</s-badge>;
}
