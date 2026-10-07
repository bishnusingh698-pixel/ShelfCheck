/**
 * Scans TRACKED files for secret-like strings (npm run secrets:check).
 * Fails (exit 1) on any hit with file:line. Placeholders (.env.example,
 * CHANGE_ME, your-*, example.com credentials, the local test Postgres
 * openhands:openhands@127.0.0.1) are explicitly allowed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SKIP_FILES = new Set([
  "package-lock.json",
  ".env.example", // documented fake values only
  "docs/SPEC.md", // quotes example token *shapes* in prose
]);

const SKIP_LINE_PATTERNS = [
  /CHANGE_?ME/i,
  /\byour[-_]/i,
  /\bexample[-_.@]/i,
  /\bfake\b/i,
  /\bplaceholder\b/i,
  /openhands:openhands@127\.0\.0\.1/,
  /<[^>]*>/, // template vars like <your-token>
  /PASSWORD="?[a-z]+ "?#/i, // commented .env lines
];

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github token", re: /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: "shopify token", re: /\b(shpat|shpca|shppa)_[a-fA-F0-9]{32}\b/ },
  { name: "shopify webhook secret", re: /\bshpss_[a-fA-F0-9]{32,}\b/ },
  { name: "resend key", re: /\bre_[A-Za-z0-9]{20,}\b/ },
  { name: "telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "stripe key", re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: "db url with password", re: /postgres(ql)?:\/\/(?!openhands:)[^\s"'`]*:[^\s"'`@]+@[^\s"'`]+/ },
  { name: "google api key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt secret-ish", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

let files: string[] = [];
try {
  files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  console.error("secrets:check: not a git repository (git ls-files failed)");
  process.exit(1);
}

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|toml|yml|yaml|sql|sh|env|example|txt|prisma|graphql|css|html)$/;
const hits: string[] = [];

for (const file of files) {
  if (SKIP_FILES.has(file) || !TEXT_EXT.test(file)) continue;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree, or binary
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (SKIP_LINE_PATTERNS.some((p) => p.test(line))) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      const m = re.exec(line);
      if (m) hits.push(`${file}:${i + 1} [${name}] ${m[0].slice(0, 24)}…`);
    }
  }
}

if (hits.length > 0) {
  for (const h of hits) console.error(`ERROR ${h}`);
  console.error(`secrets:check — ${hits.length} secret-like string(s) found`);
  process.exit(1);
}
console.log(`secrets:check — clean (${files.length} tracked files scanned)`);
