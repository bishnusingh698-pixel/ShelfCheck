/**
 * Generates locales/en-XA.json (pseudo-locale) from locales/en.json.
 * Accented vowels, ~40% longer, bracketed — catches hardcoded strings and
 * layout overflow in dev/test. Never committed by hand (.gitignored).
 *
 * ICU-aware: {name} placeholders and {count, plural, =1{…} other{…}} keep
 * their selectors, variables, and braces intact; arm bodies are transformed
 * recursively. If a string does not parse, the fallback transforms only
 * text outside braces (structure can never be corrupted).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCALES = path.resolve(process.cwd(), "locales");
const en: unknown = JSON.parse(readFileSync(path.join(LOCALES, "en.json"), "utf8"));

const ACCENTS: Record<string, string> = {
  a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý",
  A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý",
  n: "ñ", c: "ç",
};

/** Accent + ~33% expansion for literal text (whitespace is not doubled). */
function stretch(s: string): string {
  if (!s || !/\p{L}/u.test(s)) return s; // numbers, punctuation stay verbatim
  let accented = "";
  for (const ch of s) accented += ACCENTS[ch] ?? ch;
  const chars = [...accented];
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    out += chars[i];
    if ((i + 1) % 3 === 0 && !/\s/u.test(chars[i])) out += chars[i];
  }
  return out;
}

type Token =
  | { kind: "lit"; text: string }
  | { kind: "var"; name: string }
  | { kind: "icu"; name: string; type: string; arms: { sel: string; tokens: Token[] }[] };

/** Parse the subset used in locales/en.json: text, {name}, {name, plural, …}. */
function parseIcu(s: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let lit = "";
  const pushLit = () => {
    if (lit) tokens.push({ kind: "lit", text: lit });
    lit = "";
  };
  while (i < s.length) {
    if (s[i] !== "{") {
      lit += s[i];
      i += 1;
      continue;
    }
    // '{' opens either {name} or {name, type, arms…}
    const head = /^([\w.]+)\}/.exec(s.slice(i + 1));
    if (head) {
      pushLit();
      tokens.push({ kind: "var", name: head[1] });
      i += head[0].length + 1;
      continue;
    }
    const selHead = /^([\w.]+)\s*,\s*(\w+)\s*,/.exec(s.slice(i + 1));
    if (!selHead) return null; // unknown shape → caller falls back
    pushLit();
    const name = selHead[1];
    const type = selHead[2];
    i += selHead[0].length + 1; // consume "{" + "name, type,"
    const arms: { sel: string; tokens: Token[] }[] = [];
    // Arms: <selector> { <body> } <selector> { <body> } … }
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i += 1;
      const selM = /^(=\d+|[\w.]+)/.exec(s.slice(i));
      if (!selM) return null;
      const sel = selM[1];
      i += selM[0].length;
      while (i < s.length && /\s/.test(s[i])) i += 1;
      if (s[i] !== "{") return null;
      // Find the matching closing brace of this arm body.
      let depth = 0;
      let j = i;
      for (; j < s.length; j += 1) {
        if (s[j] === "{") depth += 1;
        else if (s[j] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j >= s.length) return null;
      const body = parseIcu(s.slice(i + 1, j));
      if (body === null) return null;
      arms.push({ sel, tokens: body });
      i = j + 1;
      if (s[i] === "}") {
        i += 1;
        break;
      }
      if (i >= s.length) return null;
    }
    tokens.push({ kind: "icu", name, type, arms });
  }
  pushLit();
  return tokens;
}

function render(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.kind === "lit") out += stretch(t.text);
    else if (t.kind === "var") out += `{${t.name}}`;
    else out += `{${t.name}, ${t.type}, ${t.arms.map((a) => `${a.sel} {${render(a.tokens)}}`).join(" ")}}`;
  }
  return out;
}

/** Fallback: only transform text outside ALL braces (structure-safe). */
function renderSafe(s: string): string {
  let out = "";
  let depth = 0;
  let lit = "";
  for (const ch of s) {
    if (ch === "{") {
      out += stretch(lit);
      lit = "";
      depth += 1;
      out += ch;
    } else if (ch === "}") {
      out += stretch(lit);
      lit = "";
      depth -= 1;
      out += ch;
    } else if (depth === 0) lit += ch;
    else out += ch;
  }
  out += stretch(lit);
  return out;
}

function pseudoize(s: string): string {
  const tokens = parseIcu(s);
  if (tokens === null) return `[ ${renderSafe(s)} ]`;
  const rendered = render(tokens);
  // A whole-string ICU expression already carries its own length; wrap the rest.
  const singleIcu = tokens.length === 1 && tokens[0].kind !== "lit";
  return singleIcu ? rendered : `[ ${rendered} ]`;
}

function transform(node: unknown): unknown {
  if (typeof node === "string") return pseudoize(node);
  if (node == null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = transform(v);
  return out;
}

const result = transform(en);
const target = path.join(LOCALES, "en-XA.json");
writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`i18n:pseudo — wrote ${target}`);
