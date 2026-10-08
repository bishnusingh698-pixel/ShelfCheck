import { useI18n } from "../i18n/i18n.context";

/** First-run checklist (spec <ui_spec> §1). Never a blank screen. */
export interface OnboardingStep {
  key: string;
  state: "running" | "todo" | "done";
}

export function OnboardingChecklist({ steps }: { steps: OnboardingStep[] }) {
  const { t } = useI18n();
  const labelFor: Record<string, string> = {
    scanRunning: t("dashboard.onboarding.scanRunning"),
    reviewIssues: t("dashboard.onboarding.reviewIssues"),
    setUpDigest: t("dashboard.onboarding.setUpDigest"),
  };
  return (
    <s-section heading={t("dashboard.onboarding.title")}>
      <s-ordered-list>
        {steps.map((step) => (
          <s-list-item key={step.key}>
            {step.state === "done" ? (
              <s-badge tone="success" icon="check">
                {t("dashboard.onboarding.done")}
              </s-badge>
            ) : step.state === "running" ? (
              <s-badge tone="info">{t("dashboard.scan.status.running")}</s-badge>
            ) : null}{" "}
            {labelFor[step.key]}
          </s-list-item>
        ))}
      </s-ordered-list>
    </s-section>
  );
}
