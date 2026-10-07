import { db } from "../db.server.js";
import type { PrismaClient } from "@prisma/client";

/**
 * Postgres-backed fixed-window rate limiter.
 * One row per (key, window_start). Atomic via ON CONFLICT upsert.
 * Safe through PgBouncer transaction mode: single statement, no session state.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  windowStart: Date;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = new Date(),
): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db.$queryRaw<
    Array<{ count: number }>
  >`
    INSERT INTO "RateLimitBucket" ("key", "windowStart", "count")
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimitBucket"."count" + 1
    RETURNING "count"
  `;
  const count = rows[0]?.count ?? 1;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    windowStart,
  };
}

/** Check without consuming (used to display state, not to guard). */
export async function rateLimitPeek(
  key: string,
  limit: number,
  windowMs: number,
  now = new Date(),
): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    SELECT "count" FROM "RateLimitBucket"
    WHERE "key" = ${key} AND "windowStart" = ${windowStart}
  `;
  const count = rows[0]?.count ?? 0;
  return {
    allowed: count < limit,
    remaining: Math.max(0, limit - count),
    windowStart,
  };
}

/** Best-effort cleanup of old buckets (called from tick). */
export async function pruneRateLimitBuckets(
  olderThan: Date,
  client: PrismaClient = db,
): Promise<number> {
  const result = await client.rateLimitBucket.deleteMany({ where: { windowStart: { lt: olderThan } } });
  return result.count;
}
