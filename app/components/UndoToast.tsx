import { useI18n } from "../i18n/i18n.context";
import type { ReactNode } from "react";

/**
 * Undo toast for snooze/ignore/intentional actions (spec <ui_spec> §3:
 * "each of these offers undo"). The route action returns the prior statuses;
 * clicking Undo posts `intent=restore` with them.
 */
export function UndoToast({ message, onUndo }: { message?: ReactNode; onUndo?: () => void }) {
  const { t } = useI18n();
  return (
    <s-box padding="base" aria-live="polite">
      <s-paragraph>{message ?? t("toast.saved")}</s-paragraph>
      {onUndo && (
        <s-button variant="secondary" onClick={onUndo}>
          {t("common.undo")}
        </s-button>
      )}
    </s-box>
  );
}
