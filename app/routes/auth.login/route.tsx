import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import { makeT } from "../../i18n/i18n.server.js";
import { resolveLocale } from "../../i18n/resolve-locale.js";

/** Pre-auth there is no session; use Shopify's ?locale= param when present. */
function localeFromRequest(request: Request): string {
  const param = new URL(request.url).searchParams.get("locale");
  return resolveLocale(param);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const t = makeT(localeFromRequest(request));
  const errors = loginErrorMessage(await login(request), t);

  return { errors, t: { heading: t("auth.heading"), shopLabel: t("auth.shopLabel"), shopDetails: t("auth.shopDetails"), button: t("auth.button") } };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const t = makeT(localeFromRequest(request));
  const errors = loginErrorMessage(await login(request), t);

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <>
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      <s-page>
        <Form method="post">
        <s-section heading={loaderData.t.heading}>
          <s-text-field
            name="shop"
            label={loaderData.t.shopLabel}
            details={loaderData.t.shopDetails}
            value={shop}
            onChange={(e) => setShop(e.currentTarget.value)}
            autocomplete="on"
            error={errors.shop}
          ></s-text-field>
          <s-button type="submit">{loaderData.t.button}</s-button>
        </s-section>
        </Form>
      </s-page>
    </>
  );
}
