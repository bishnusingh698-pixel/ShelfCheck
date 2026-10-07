import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useI18n } from "../i18n/i18n.client";

/**
 * Dashboard (first-run skeleton). The full dashboard — health score, counts,
 * scan status, plan usage, trend — lands in Phase 8; this first version ships
 * the onboarding checklist so a fresh install is never a blank screen
 * (spec <ui_spec> §1).
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {
  const { t } = useI18n();

  return (
    <s-page heading={t("dashboard.title")}>
      <s-section heading={t("dashboard.onboarding.title")}>
        <s-ordered-list>
          <s-list-item>{t("dashboard.onboarding.scanRunning")}</s-list-item>
          <s-list-item>{t("dashboard.onboarding.reviewIssues")}</s-list-item>
          <s-list-item>{t("dashboard.onboarding.setUpDigest")}</s-list-item>
        </s-ordered-list>
      </s-section>
      <s-section>
        <s-paragraph>{t("app.tagline")}</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
