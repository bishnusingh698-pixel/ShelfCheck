import { db } from "../db.server.js";

/**
 * Transaction-scoped advisory lock helper.
 * Neon's pooled endpoint uses PgBouncer in transaction mode, where session-level
 * pg_advisory_lock is unsafe. We use pg_try_advisory_xact_lock, which:
 *  - auto-releases at transaction end,
 *  - works identically through transaction poolers.
 *
 * The single-argument bigint form lets us use one namespaced 64-bit key:
 *   key = (NAMESPACE << 32) | fnv1a32(shopId)
 * (The two-argument form is (int, int), which cannot hold a 64-bit hash.)
 *
 * IMPORTANT: the caller MUST run this inside a single transaction
 * (db.$transaction), otherwise the lock releases immediately.
 */

const NAMESPACE = 620221n; // arbitrary fixed namespace for ShelfCheck

/** Namespaced 64-bit advisory-lock key for a shop id, as a decimal string. */
export function shopLockKey(shopId: string): string {
  let hash = 0x811c9dc5n; // FNV-1a 32-bit
  const prime = 0x01000193n;
  for (const byte of Buffer.from(shopId, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffn;
  }
  const key = (NAMESPACE << 32n) | hash;
  return key.toString();
}

/** Try to take the per-shop lock. Returns false if another worker holds it. */
export async function tryLockShop(
  shopId: string,
  tx: { $queryRaw: Function } | typeof db = db,
): Promise<boolean> {
  const key = shopLockKey(shopId);
  // Prisma cannot serialize JS bigint parameters, so pass a string and cast.
  const rows = await (tx as typeof db).$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(${key}::bigint) AS locked
  `;
  return rows[0]?.locked === true;
}

/** Convenience: run fn inside a transaction holding the shop lock; returns null if busy. */
export async function withShopLock<T>(
  shopId: string,
  fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    const locked = await tryLockShop(shopId, tx);
    if (!locked) return null;
    return fn(tx as never);
  });
}
