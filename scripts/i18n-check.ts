/**
 * i18n parity checker (npm run i18n:check). Fails the build on:
 *  - missing keys, extra keys, empty values (vs locales/en.json)
 *  - {name} placeholder mismatches
 *  - missing ICU plural categories for the locale (derived live from
 *    Intl.PluralRules, so the CLDR table is never hard-coded)
 *  - strings identical to English that are not on the untranslated allowlist
 *
 * A locale whose file does not exist yet is a WARNING until I18N_REQUIRE_ALL=1
 * (set from Phase 12 on) — files are added one per work packet (D-23).
 * en-XA is generated (npm run i18n:pseudo); parity is checked, translation
 * equality is not.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { SUPPORTED_LOCALES, PSEUDO_LOCALE, BRAND_TERMS } from "../app/i18n/config.js";

type Json = string | { [k: string]: Json };

const LOCALES_DIR = path.resolve(process.cwd(), "locales");
const REQUIRE_ALL = process.env.I18N_REQUIRE_ALL === "1";

/** Locales where a string may legitimately equal the English source. */
const SAME_AS_EN_ALLOWLIST: Record<string, string[]> = {
  // Filled during Phase 12 with reviewed per-locale exceptions (brand terms,
  // acronyms, established loanwords like "Dashboard" in German).
};

const errors: string[] = [];
const warnings: string[] = [];

function load(locale: string): Json | null {
  const file = path.join(LOCALES_DIR, `${locale}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

function flatten(node: Json, prefix: string, out: Map<string, string>): void {
  if (typeof node === "string") {
    out.set(prefix, node);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

function placeholders(s: string): string[] {
  // {name} placeholders, ignoring the selector of {count, plural, ...} itself.
  const out: string[] = [];
  const re = /\{(\w+)(?=[,}])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

function pluralArms(s: string): string[] {
  const m = /\{\w+,\s*plural,\s*([^}]*(?:\{[^{}]*\}[^{}]*)*)\}/.exec(s);
  if (!m) return [];
  const body = m[1];
  const arms: string[] = [];
  const re = /(=\d+|[a-z]+)\{/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(body)) !== null) arms.push(a[1]);
  return arms;
}

function requiredPluralCategories(locale: string): Set<string> {
  // Categories this locale actually selects for a spread of counts.
  const counts = [0, 1, 2, 3, 5, 7, 11, 100, 1000, 1_000_000, 1_000_000.5];
  const set = new Set<string>();
  const pr = new Intl.PluralRules(locale);
  for (const c of counts) set.add(pr.select(c));
  return set;
}

function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s);
}

function brandOnly(s: string): boolean {
  const stripped = s.replace(new RegExp(BRAND_TERMS.join("|"), "g"), "").replace(/[\p{P}\p{S}\s]/gu, "");
  return stripped.length === 0;
}

const en = load("en");
if (!en) {
  console.error("i18n:check: locales/en.json is missing");
  process.exit(1);
}
const enFlat = new Map<string, string>();
flatten(en, "", enFlat);

for (const locale of [...SUPPORTED_LOCALES, PSEUDO_LOCALE]) {
  const data = load(locale);
  if (!data) {
    if (locale === "en") continue; // guarded above
    const msg = `locale file missing: locales/${locale}.json`;
    if (REQUIRE_ALL || locale === PSEUDO_LOCALE) errors.push(msg);
    else warnings.push(msg);
    continue;
  }
  const flat = new Map<string, string>();
  flatten(data, "", flat);

  const isPseudo = locale === PSEUDO_LOCALE;
  const categories = requiredPluralCategories(locale);

  for (const [key, enValue] of enFlat) {
    if (!flat.has(key)) {
      errors.push(`${locale}: missing key ${key}`);
      continue;
    }
    const value = flat.get(key) as string;
    if (value.trim().length === 0) {
      errors.push(`${locale}: empty value for ${key}`);
      continue;
    }
    const phEn = placeholders(enValue).sort().join(",");
    const phLoc = placeholders(value).sort().join(",");
    if (phEn !== phLoc) {
      errors.push(`${locale}: placeholder mismatch for ${key} (en: {${phEn}} vs {${phLoc}})`);
    }
    for (const arm of pluralArms(enValue)) {
      if (arm.startsWith("=")) continue; // exact matches are always allowed
      if (!pluralArms(value).includes(arm)) {
        errors.push(`${locale}: plural arm '${arm}' missing for ${key}`);
      }
    }
    for (const arm of pluralArms(value)) {
      if (arm.startsWith("=")) continue;
      if (!categories.has(arm)) {
        errors.push(`${locale}: plural arm '${arm}' is not a CLDR category for this locale (${key})`);
      }
    }
    if (isPseudo) continue;
    if (locale === "en") continue; // the source locale IS English
    if (
      value === enValue &&
      hasLetters(enValue) &&
      !brandOnly(enValue) &&
      !(SAME_AS_EN_ALLOWLIST[locale] ?? []).includes(key)
    ) {
      errors.push(`${locale}: untranslated (identical to English): ${key}`);
    }
  }
  for (const key of flat.keys()) {
    if (!enFlat.has(key)) errors.push(`${locale}: extra key ${key}`);
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(
  `i18n:check — ${SUPPORTED_LOCALES.length + 1} locales checked, en has ${enFlat.size} strings. ` +
    `${errors.length} error(s), ${warnings.length} warning(s).`,
);
if (errors.length > 0) process.exit(1);
