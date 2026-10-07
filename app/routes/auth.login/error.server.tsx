import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

export type Translate = (key: string, params?: Record<string, unknown>) => string;

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError, t: Translate): LoginErrorMessage {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: t("auth.error.missingShop") };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: t("auth.error.invalidShop") };
  }

  return {};
}
