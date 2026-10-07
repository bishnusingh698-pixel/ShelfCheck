import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { translateTemplate, type Messages } from "./translate.js";

/**
 * Client i18n: a React context carrying the resolved locale and its message
 * catalog (fetched by the app layout's server loader). Rendering goes
 * through the same pure ICU renderer the server uses (translate.ts).
 */

export interface I18nValue {
  locale: string;
  messages: Messages;
  t: (key: string, params?: Record<string, unknown>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: string;
  messages: Messages;
  children: ReactNode;
}) {
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      messages,
      t: (key, params = {}) => translateTemplate(messages, locale, key, params),
    }),
    [locale, messages],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
