import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireAdminShopContext } from "../lib/auth.server.js";
import { getEnv } from "../env.server.js";
import { adminHttpsUrl } from "../lib/admin-urls.js";
import { translateTemplate, type Messages } from "../i18n/translate.js";
import { useI18n } from "../i18n/i18n.context";
import { formatNumber } from "../i18n/format";
import { PLANS, type PlanId, type PlanLimits } from "../billing/plans.js";

/**
 * Plans comparison + upgrade (spec <ui_spec> §6). Plan truth comes from the
 * stored row (fed by app_subscriptions/update); the upgrade button opens the
 * Managed Pricing page in the merchant's admin (docs/api-notes.md §8 —
 * exact URL form is [LIVE]-pending; the https fallback form is used).
 */

const PLAN_ORDER: PlanId[] = ["free", "starter", "pro"];

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const env = getEnv();
  const handle = shop.shopHandle ?? shop.shopDomain.replace(/\.myshopify\.com$/, "");
  const appHandle = new URL(env.SHOPIFY_APP_URL).hostname.replace(/[._]/g, "-");

  return {
    currentPlan: shop.plan,
    planStatus: shop.planStatus,
    plans: PLAN_ORDER.map((id) => limitsFor(id)),
    pricingUrl: adminHttpsUrl(handle, `apps/${appHandle}/pricing`),
  };
}

function limitsFor(id: PlanId): PlanLimits {
  return PLANS[id];
}

export default function PlansRoute() {
  const { t, locale } = useI18n();
  const data = useLoaderData<typeof loader>();

  const cell = (limits: PlanLimits, feature: keyof PlanLimits): string => {
    const value = limits[feature];
    if (typeof value === "boolean") return value ? t("plans.yes") : t("plans.no");
    if (typeof value === "number") return value === 0 ? t("plans.unlimited") : formatNumber(value, locale);
    return t(`plans.scheduled.${value}`);
  };

  return (
    <s-page heading={t("plans.title")}>
      <s-section>
        <s-table variant="list">
          <s-table-header>
            <s-table-header-row>
              <s-table-header>{t("plans.compare")}</s-table-header>
              {data.plans.map((p) => (
                <s-table-header key={p.id}>
                  {t(p.labelKey)}
                  {p.id === data.currentPlan && <s-badge tone="success">{t("plans.current")}</s-badge>}
                </s-table-header>
              ))}
            </s-table-header-row>
          </s-table-header>
          <s-table-body>
            {(
              [
                ["scheduled", "plans.feature.scans"],
                ["manualScansPerDay", "plans.feature.manualScans"],
                ["issueVisibilityLimit", "plans.feature.issuesShown"],
                ["variantCap", "plans.feature.variantCap"],
                ["webhookWatchers", "plans.feature.watchers"],
                ["emailDigest", "plans.feature.digest"],
                ["csvExportRows", "plans.feature.csv"],
                ["autoTag", "plans.feature.autoTag"],
                ["telegram", "plans.feature.telegram"],
              ] as Array<[keyof PlanLimits, string]>
            ).map(([feature, labelKey]) => (
              <s-table-row key={feature}>
                <s-table-cell>{t(labelKey)}</s-table-cell>
                {data.plans.map((p) => (
                  <s-table-cell key={p.id}>{cell(p, feature)}</s-table-cell>
                ))}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section>
        <s-link href={data.pricingUrl} target="_blank">
          {t("plans.openManagedPricing")}
        </s-link>
      </s-section>
    </s-page>
  );
}

export const meta: MetaFunction = ({ matches }) => {
  const layout = matches.find(
    (m) => m.id === "routes/app" && (m.data as { messages?: Messages } | null)?.messages,
  );
  const data = (layout?.data ?? null) as { locale: string; messages: Messages } | null;
  if (!data) return [];
  const screen = translateTemplate(data.messages, data.locale, "plans.title");
  return [{ title: translateTemplate(data.messages, data.locale, "app.documentTitle", { title: screen }) }];
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
