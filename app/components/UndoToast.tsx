import { useI18n } from "../i18n/i18n.context";

/**
 * TODO (Phase 9): UndoToast — undo for snooze/ignore/intentional bulk
 * actions. Defined here so app.issues.tsx can import it; the snooze/
 * ignore endpoints land with the issues screen.
 */
export function UndoToast({ onUndo }: { onUndo?: () => void }) {
  const { t } = useI18n();
  return (
    <s-box padding="base">
      <s-paragraph>{t("toast.undone")}</s-paragraph>
      {onUndo && (
        <s-button variant="secondary" onClick={onUndo}>
          {t("common.undo")}
        </s-button>
      )}
    </s-box>
  );
}
