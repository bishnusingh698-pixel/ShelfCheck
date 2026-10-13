/**
 * Dead-code check (part of npm run verify): every file under app/ must be
 * reachable from the real entry points through the import graph, and every
 * exported symbol must be referenced somewhere in the repo.
 *
 * Entry points (alive by construction):
 *  - every route file under app/routes/ (React Router file conventions,
 *    including nested directories like auth.login/route.tsx)
 *  - app/root.tsx, app/entry.client.tsx, app/entry.server.tsx
 *  - server/index.ts (the production entry from package.json "start"),
 *    which pulls in app/shopify.server.ts
 *
 * Consumers for export liveness include tests/, scripts/, and server/:
 * helpers exported for testability that the suite actually exercises are
 * live. Framework-discovered route exports (loader, action, meta,
 * ErrorBoundary, …) are reachable by name, not by import.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();

const FRAMEWORK_EXPORTS = new Set([
  "default",
  "loader",
  "action",
  "clientLoader",
  "clientAction",
  "headers",
  "meta",
  "links",
  "shouldRevalidate",
  "handle",
  "ErrorBoundary",
  "HydrateFallback",
]);

const IMPORT_RE = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;
const EXPORT_RE =
  /(?:^|\n)[ \t]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST_RE = /(?:^|\n)[ \t]*export\s*\{([^}]*)\}/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "build" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "server"))]
  .map((f) => relative(ROOT, f).split(sep).join("/"))
  .filter((f) => !f.endsWith(".d.ts"));

const consumerFiles = [
  ...sourceFiles,
  ...walk(join(ROOT, "tests")).map((f) => relative(ROOT, f).split(sep).join("/")),
  ...walk(join(ROOT, "scripts")).map((f) => relative(ROOT, f).split(sep).join("/")),
];

const text = new Map<string, string>();
for (const f of consumerFiles) text.set(f, readFileSync(join(ROOT, f), "utf8"));

/** Resolve a relative import specifier to a repo file, or null. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const base = resolve(ROOT, dirname(join(ROOT, fromFile)), spec);
  // TS convention: ESM specifiers end in .js but the file on disk is .ts.
  const stem = base.replace(/\.(js|jsx|mjs)$/, "");
  const candidates = [
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${stem}.mjs`,
    join(stem, "index.ts"),
    join(stem, "index.tsx"),
  ];
  const normalized = (p: string) => relative(ROOT, p).split(sep).join("/");
  for (const c of candidates) {
    const n = normalized(c);
    if (sourceFiles.includes(n)) return n;
  }
  return null;
}

/** All repo files reachable (transitively) from `entries`. */
function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(join(ROOT, file), "utf8");
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const target = resolveImport(file, m[1]!);
      if (target) queue.push(target);
    }
    // Side-effect CSS imports.
    const cssRe = /["'](\.[^"']+\.css)["']/g;
    while ((m = cssRe.exec(src)) !== null) {
      const n = relative(ROOT, resolve(ROOT, dirname(join(ROOT, file)), m[1]!))
        .split(sep)
        .join("/");
      if (statSync(join(ROOT, n), { throwIfNoEntry: false })) seen.add(n);
    }
  }
  return seen;
}

const routeFiles = sourceFiles.filter((f) => f.startsWith("app/routes/"));
const entries = [
  ...routeFiles,
  "app/root.tsx",
  "app/entry.client.tsx",
  "app/entry.server.tsx",
  "app/routes.ts",
  "server/index.ts",
].filter((f) => sourceFiles.includes(f) || f === "app/routes.ts");

const alive = reachableFrom(entries);

const deadFiles: string[] = [];
for (const f of sourceFiles) {
  if (!f.startsWith("app/")) continue;
  if (!alive.has(f)) deadFiles.push(f);
}
// CSS files: alive iff any alive TS file imports them by name.
const cssFiles = walk(join(ROOT, "app"))
  .filter((f) => f.endsWith(".css"))
  .map((f) => relative(ROOT, f).split(sep).join("/"));
for (const css of cssFiles) {
  const base = css.split("/").pop()!;
  const imported = [...alive].some(
    (f) => !f.endsWith(".css") && (text.get(f) ?? "").includes(base),
  );
  if (!imported) deadFiles.push(css);
}

// --- Export liveness --------------------------------------------------------
const deadExports: { file: string; name: string }[] = [];
const corpus = consumerFiles.map((f) => text.get(f)!).join("\n");

for (const file of sourceFiles) {
  const src = text.get(file) ?? readFileSync(join(ROOT, file), "utf8");
  const isRouteOrRoot = file.startsWith("app/routes/") || file === "app/root.tsx";
  // Framework entry contract: names in entry.* are called by react-router.
  const isFrameworkEntry = file === "app/entry.server.tsx" || file === "app/entry.client.tsx";
  if (isFrameworkEntry) continue;
  const own = new Set<string>();

  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(src)) !== null) {
    // `export default function Name` — the framework reaches it by role.
    if (m[0].includes("default")) continue;
    const name = m[2]!;
    if (isRouteOrRoot && FRAMEWORK_EXPORTS.has(name)) continue;
    own.add(name);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(src)) !== null) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        if (isRouteOrRoot && FRAMEWORK_EXPORTS.has(name)) continue;
        own.add(name);
      }
    }
  }

  for (const name of own) {
    // Dead only if the symbol never appears outside its own declaration
    // anywhere in the repo (app, server, tests, scripts).
    const re = new RegExp(`\\b${name}\\b`, "g");
    const uses = (corpus.match(re) ?? []).length;
    const declRe = new RegExp(
      `\\b(?:function|const|let|var|class|type|interface|enum)\\s+${name}\\b`,
      "g",
    );
    const decls = (corpus.match(declRe) ?? []).length;
    if (uses <= decls) deadExports.push({ file, name });
  }
}

if (deadFiles.length > 0 || deadExports.length > 0) {
  console.error("Dead code found:");
  for (const f of deadFiles) console.error(`  unreachable file: ${f}`);
  for (const e of deadExports) console.error(`  unreferenced export: ${e.file} → ${e.name}`);
  process.exit(1);
}

console.log(
  `dead-code check: ${sourceFiles.length} app+server files, ${routeFiles.length} routes, all reachable, no unreferenced exports`,
);
