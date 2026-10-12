import { useI18n } from "../i18n/i18n.context";
import { productAdminPath } from "../lib/admin-urls";
import type { NeedsAttentionItem } from "../activity/queries.server";

/**
 * Top new high-severity issues since the last visit (spec <ui_spec>): the
 * short list that needs the merchant's immediate attention, with deep links
 * into the issues page and the Shopify admin.
 */
export function NeedsAttentionList({
  items,
  shopHandle,
}: {
  items: NeedsAttentionItem[];
  shopHandle: string | null;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;

  return (
    <s-section heading={t("dashboard.needsAttention.title")}>
      <ul>
        {items.map((item) => (
          <li key={item.issueId}>
            <s-stack gap="base">
              <s-badge tone="critical">{t(`issue.type.${item.type}`)}</s-badge>
              {item.isNew && <s-badge tone="info">{t("issue.list.newBadge")}</s-badge>}
              <s-paragraph>{item.productTitle ?? item.skuNorm ?? item.variantGid}</s-paragraph>
              <s-link href={`/app/issues?search=${encodeURIComponent(item.skuNorm ?? item.variantGid)}`}>
                {t("dashboard.needsAttention.view")}
              </s-link>
              {shopHandle && (
                <s-link href={productAdminPath(shopHandle, item.variantGid)} target="_blank">
                  {t("dashboard.needsAttention.openInAdmin")}
                </s-link>
              )}
            </s-stack>
          </li>
        ))}
      </ul>
    </s-section>
  );
}
