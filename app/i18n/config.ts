/**
 * Supported locales, fallback chains, and brand-term allowlist.
 * Source locale: en. Others produced in Phase 12, kept in sync after.
 */

export const SOURCE_LOCALE = "en" as const;

export const SUPPORTED_LOCALES = [
  "en",
  "de",
  "fr",
  "es",
  "pt-BR",
  "pt-PT",
  "zh-CN",
  "ja",
  "it",
  "nl",
  "sv",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Pseudo-locale for dev/test only, generated, never committed by hand. */
export const PSEUDO_LOCALE = "en-XA" as const;

/** Never translated: brand terms and codes. */
export const BRAND_TERMS = ["ShelfCheck", "SKU", "GTIN", "CSV", "Shopify", "Telegram", "Matrixify"];

/** Fallback chains: try exact, then language, then en. */
const FALLBACKS: Record<string, string[]> = {
  "pt-PT": ["pt-PT", "pt-BR", "en"],
  "zh-TW": ["zh-CN", "en"],
  "zh-Hans": ["zh-CN", "en"],
  "zh-Hans-CN": ["zh-CN", "en"],
  "zh-Hant": ["zh-CN", "en"],
  "zh": ["zh-CN", "en"],
  "pt": ["pt-BR", "en"],
  "de-AT": ["de", "en"],
  "de-CH": ["de", "en"],
  "de-DE": ["de", "en"],
  "fr-CA": ["fr", "en"],
  "fr-FR": ["fr", "en"],
  "es-MX": ["es", "en"],
  "es-ES": ["es", "en"],
  "es-419": ["es", "en"],
  "ja-JP": ["ja", "en"],
  "it-IT": ["it", "en"],
  "nl-NL": ["nl", "en"],
  "nl-BE": ["nl", "en"],
  "sv-SE": ["sv", "en"],
  "pt-BR": ["pt-BR", "en"],
  "en-XA": ["en-XA", "en"],
};

export function fallbackChain(locale: string): string[] {
  if (FALLBACKS[locale]) return FALLBACKS[locale];
  // Exact supported locale.
  if ((SUPPORTED_LOCALES as readonly string[]).includes(locale)) return [locale, "en"];
  // Language part only, e.g. "pt-FR" → "pt".
  const lang = locale.split("-")[0];
  if (FALLBACKS[lang]) return [...FALLBACKS[lang]];
  return ["en"];
}
