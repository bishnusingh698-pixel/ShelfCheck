/**
 * Rolls back the N most recent Prisma migrations by running each hand-written
 * down.sql, then removing their rows from _prisma_migrations.
 * Usage: node scripts/migrate-down.mjs [N]   (default 1)
 * Prisma migrations are forward-only; the down.sql files next to each
 * migration.sql are the spec's "reversible migrations" mechanism.
 *
 * DATABASE_URL must point at the DIRECT (non-pooled) database URL.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const n = Number(process.argv[2] ?? 1);
if (!Number.isInteger(n) || n < 1) {
  console.error("usage: node scripts/migrate-down.mjs [N]");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate-down: DATABASE_URL is required (use the DIRECT connection string)");
  process.exit(1);
}

const dir = path.resolve("prisma", "migrations");
const all = readdirSync(dir).filter((d) => existsSync(path.join(dir, d, "migration.sql"))).sort();
if (all.length === 0) {
  console.error("migrate-down: no migrations found");
  process.exit(1);
}

const targets = all.slice(-n);
if (targets.length < n) {
  console.error(`migrate-down: only ${all.length} migration(s) applied, cannot roll back ${n}`);
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

/** down.sql files contain plain DDL; split on statement-ending semicolons. */
function statements(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim())
    .filter((s) => s.length > 0);
}

try {
  for (const name of [...targets].reverse()) {
    const downPath = path.join(dir, name, "down.sql");
    if (!existsSync(downPath)) {
      console.error(`migrate-down: ${name}/down.sql is missing`);
      process.exit(1);
    }
    const sql = readFileSync(downPath, "utf8");
    console.log(`rolling back ${name} (${statements(sql).length} statements)`);
    for (const stmt of statements(sql)) {
      await prisma.$executeRawUnsafe(stmt);
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = '${name.replace(/'/g, "''")}'`,
    );
  }
  console.log(`migrate-down: rolled back ${targets.length} migration(s)`);
} finally {
  await prisma.$disconnect();
}
