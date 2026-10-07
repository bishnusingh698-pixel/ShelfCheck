import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { requireShopContext } from "../lib/shop-context.server.js";
import { getMessages } from "../i18n/i18n.server.js";
import { resolveLocale } from "../i18n/resolve-locale.js";
import { I18nProvider, useI18n } from "../i18n/i18n.client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await requireShopContext(session);

  // Merchant's saved interface language wins; then the locale Shopify reports
  // for this admin session; then English.
  const url = new URL(request.url);
  const locale = resolveLocale(shop.uiLocale ?? url.searchParams.get("locale"));

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    locale,
    messages: getMessages(locale),
  };
};

function AppNav() {
  const { t } = useI18n();
  return (
    <s-app-nav>
      <s-link href="/app">{t("nav.dashboard")}</s-link>
    </s-app-nav>
  );
}

export default function App() {
  const { apiKey, locale, messages } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <I18nProvider locale={locale} messages={messages}>
        <AppNav />
        <Outlet />
      </I18nProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
