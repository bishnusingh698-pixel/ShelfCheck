import { fallbackChain, SUPPORTED_LOCALES, type SupportedLocale } from "./config.js";

/**
 * Map a Shopify locale string to a supported locale (pure).
 * Shopify sends e.g. "en-US", "de-DE", "pt-BR", "zh-Hans-CN".
 */

export function resolveLocale(input: string | null | undefined): SupportedLocale {
  const raw = (input ?? "").trim();
  if (!raw) return "en";

  // Exact match first.
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) {
    return raw as SupportedLocale;
  }

  // Case-insensitive exact match.
  const lower = raw.toLowerCase();
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;

  // Walk the fallback chain until we hit a supported locale.
  for (const candidate of fallbackChain(raw)) {
    const found = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }

  return "en";
}

/** All locales that must exist on disk (source + translated; en-XA generated). */
export const BUILD_LOCALES = [...SUPPORTED_LOCALES];
