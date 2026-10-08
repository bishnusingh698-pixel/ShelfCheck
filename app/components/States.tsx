import { useI18n } from "../i18n/i18n.context";
import type { ReactNode } from "react";

/** Shared empty state (spec <file_layout> components). */
export function EmptyState({ message, children }: { message?: string; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <s-box padding="base">
      <s-paragraph>{message ?? t("common.empty")}</s-paragraph>
      {children}
    </s-box>
  );
}

/** Shared error state with retry (spec <file_layout> components). */
export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <s-box padding="base">
      <s-paragraph>{t("common.errorTitle")}</s-paragraph>
      <s-paragraph>{t("common.errorBody")}</s-paragraph>
      {onRetry && (
        <s-button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </s-button>
      )}
    </s-box>
  );
}

/** Loading skeleton per screen — headings stay visible, content shimmering. */
export function Skeletons({ rows = 3 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("common.loading")}>
      <s-spinner accessibilityLabel={t("common.loading")}></s-spinner>
      {Array.from({ length: rows }, (_, i) => (
        <s-box key={i} padding="base">
          <s-paragraph>{t("common.loading")}</s-paragraph>
        </s-box>
      ))}
    </div>
  );
}

/** Explains what is locked by plan and why (spec <file_layout> components). */
export function LockedFeature({ message }: { message: string }) {
  return <s-badge tone="info">{message}</s-badge>;
}
