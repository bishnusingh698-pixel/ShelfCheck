import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackChain } from "./config.js";
import { translateTemplate, type Messages } from "./translate.js";

/**
 * Server i18n (loaders, emails, Telegram). Loads locales/*.json along the
 * fallback chain from config.ts and renders through the pure shared ICU
 * renderer in translate.ts — the same code the browser bundle uses.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

export interface I18nBackend {
  t: (key: string, options?: Record<string, unknown>) => string;
}

export type { Messages };

function flatten(obj: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (obj == null) return out;
  if (typeof obj === "string") {
    out[prefix.replace(/\.$/, "")] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function loadLocaleFiles(locale: string): Messages {
  const chain = [...new Set([...fallbackChain(locale), "en"])];
  const merged: Record<string, string> = {};
  // Apply from the end of the chain (en first) so more specific win.
  for (const loc of chain.reverse()) {
    try {
      const file = path.resolve(here, "../../locales", `${loc}.json`);
      const json = require(file) as Record<string, unknown>;
      Object.assign(merged, flatten(json));
    } catch {
      // Missing locale file: skip; earlier entries fill in.
    }
  }
  return merged;
}

const cache = new Map<string, Messages>();

export function getMessages(locale: string): Messages {
  const cached = cache.get(locale);
  if (cached) return cached;
  const messages = loadLocaleFiles(locale);
  cache.set(locale, messages);
  return messages;
}

/**
 * Rendering lives in translate.ts (shared with the client). These thin
 * wrappers keep the historical server API (translate / makeT).
 */
export function translate(locale: string, key: string, params: Record<string, unknown> = {}): string {
  return translateTemplate(getMessages(locale), locale, key, params);
}

export function makeT(locale: string) {
  return (key: string, params: Record<string, unknown> = {}) => translate(locale, key, params);
}
