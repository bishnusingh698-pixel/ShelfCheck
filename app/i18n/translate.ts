/**
 * Pure ICU MessageFormat renderer — shared by the server (loaders, emails,
 * Telegram) and the client. No I/O, no filesystem, no framework.
 *
 * Supports {name} placeholders and one level of {count, plural, ...} with
 * CLDR plural categories via Intl.PluralRules. Keys are flat dot-notation
 * strings over a `Messages` map (see app/i18n/config.ts for locales).
 */

export type Messages = Record<string, string>;

/** Find the index just past the balanced closing brace starting at `openIdx`. */
function matchBalanced(template: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < template.length; i++) {
    if (template[i] === "{") depth += 1;
    else if (template[i] === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parse "cat{...} cat{...}" arms of a plural body (after the variable name). */
function parseArms(body: string): Map<string, string> {
  const arms = new Map<string, string>();
  const re = /(=([0-9]+)|zero|one|two|few|many|other)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const armName = m[2] ? `=${m[2]}` : m[1];
    const openIdx = body.indexOf("{", m.index + m[1].length);
    const end = matchBalanced(body, openIdx);
    if (end === -1) break;
    arms.set(armName, body.slice(openIdx + 1, end - 1));
    re.lastIndex = end;
  }
  return arms;
}

function cldrPluralCategory(locale: string, count: number): "zero" | "one" | "two" | "few" | "many" | "other" {
  try {
    return new Intl.PluralRules(locale).select(count) as ReturnType<typeof cldrPluralCategory>;
  } catch {
    return count === 1 ? "one" : "other";
  }
}

function renderPlural(
  locale: string,
  template: string,
  params: Record<string, unknown>,
): string {
  // ICU form: "{var, plural, =0{...} one{...} other{...}}" — the arms sit
  // directly between "plural," and the brace that closes the whole expression.
  const start = template.search(/\{\w+,\s*plural,\s*/);
  if (start === -1) return template;
  const varMatch = /\{(\w+),\s*plural,\s*/.exec(template.slice(start));
  if (!varMatch) return template;
  const varName = varMatch[1];
  const outerEnd = matchBalanced(template, start); // matches the brace at `start`
  if (outerEnd === -1) return template;
  const body = template.slice(start + varMatch[0].length, outerEnd - 1);
  const count = Number(params[varName] ?? 0);
  const arms = parseArms(body);
  const arm = arms.get(`=${count}`) ?? arms.get(cldrPluralCategory(locale, count)) ?? arms.get("other") ?? "";
  // '#' inside the arm renders as the count.
  const rendered = arm.replace(/#/g, formatCount(locale, count));
  return template.slice(0, start) + rendered + template.slice(outerEnd);
}

function formatCount(locale: string, count: number): string {
  try {
    return new Intl.NumberFormat(locale).format(count);
  } catch {
    return String(count);
  }
}

/** Translate `key` over `messages` for `locale`. Missing key → the key itself. */
export function translateTemplate(
  messages: Messages,
  locale: string,
  key: string,
  params: Record<string, unknown> = {},
): string {
  let template = messages[key];
  if (typeof template !== "string") {
    return key;
  }
  template = renderPlural(locale, template, params);
  // Simple {placeholders} (any remaining, including nested arms already rendered).
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  );
}
