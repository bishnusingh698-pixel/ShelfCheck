import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticateAdmin } from "../lib/auth.server.js";
import { uiHarnessActive } from "../lib/ui-harness.server.js";
import { requireShopContext } from "../lib/shop-context.server.js";
import { getEnv } from "../env.server.js";
import { getMessages } from "../i18n/i18n.server.js";
import { PSEUDO_LOCALE } from "../i18n/config.js";
import { resolveLocale } from "../i18n/resolve-locale.js";
import { I18nProvider, useI18n } from "../i18n/i18n.context";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const shop = await requireShopContext(session);

  // Merchant's saved interface language wins; then the locale Shopify reports
  // for this admin session; then English.
  const url = new URL(request.url);
  const urlLocale = url.searchParams.get("locale");
  // The generated pseudo locale is test-only (en-XA is not a merchant
  // language, so resolveLocale never yields it in production): the UI
  // harness honors it so Playwright can exercise the pseudo catalog.
  const locale =
    uiHarnessActive() && urlLocale === PSEUDO_LOCALE
      ? PSEUDO_LOCALE
      : resolveLocale(shop.uiLocale ?? urlLocale);

  return {
    apiKey: getEnv().SHOPIFY_API_KEY || "",
    locale,
    messages: getMessages(locale),
    // App Bridge cannot run outside the Shopify admin iframe; the test-only
    // UI harness renders the same screens without it.
    harness: uiHarnessActive(),
  };
}

function AppNav() {
  const { t } = useI18n();
  return (
    <s-app-nav>
      <s-link href="/app">{t("nav.dashboard")}</s-link>
      <s-link href="/app/issues">{t("nav.issues")}</s-link>
      <s-link href="/app/rules">{t("nav.rules")}</s-link>
      <s-link href="/app/settings">{t("nav.settings")}</s-link>
      <s-link href="/app/plans">{t("nav.plans")}</s-link>
    </s-app-nav>
  );
}

export default function App() {
  const { apiKey, locale, messages, harness } = useLoaderData<typeof loader>();

  const app = (
    <I18nProvider locale={locale} messages={messages}>
      <AppNav />
      <Outlet />
    </I18nProvider>
  );

  return (
    <>
      {/* Polaris web components (the s-* elements used across the app). */}
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      {harness ? app : <AppProvider apiKey={apiKey}>{app}</AppProvider>}
    </>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
