import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  resetDb,
  disposeTestDb,
  testDb,
  createShop,
} from "../helpers/db.js";
import { enqueue, claimJob, failJob, drainJobs, reclaimStuckJobs } from "../../app/jobs/queue.server.js";
import { tick } from "../../app/jobs/tick.server.js";
import { buildHandlerMap, validatePayload, PRODUCT_SYNC_SCHEMA } from "../../app/jobs/handlers.server.js";
import { tryLockShop, withShopLock } from "../../app/lib/advisory-lock.server.js";
import { rateLimit } from "../../app/lib/rate-limit.server.js";
import pino from "pino";

const logger = pino({ level: "silent" });

beforeAll(async () => {
  await testDb().$queryRaw`SELECT 1`;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disposeTestDb();
});

describe("job queue", () => {
  it("claims each job exactly once under concurrent claim attempts", async () => {
    const db = testDb();
    for (let i = 0; i < 20; i++) {
      await enqueue({ kind: "stub", payload: { n: i } }, db);
    }
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimJob(randomUUID(), db)),
    );
    const nonNull = claims.filter((c) => c !== null);
    expect(nonNull).toHaveLength(5); // 5 workers each got a distinct job
    const ids = new Set(nonNull.map((c) => c.id));
    expect(ids.size).toBe(5); // all distinct
  });

  it("drains all jobs without double-processing", async () => {
    const db = testDb();
    const processed: string[] = [];
    for (let i = 0; i < 10; i++) {
      await enqueue({ kind: "stub", payload: { n: i } }, db);
    }
    const handler = buildHandlerMap({
      // handler that records and never fails
    });
    const count1 = await drainJobs({ logger, maxDrainMs: 5000, handler: async (job) => { processed.push(job.id); }, client: db });
    expect(count1).toBe(10);
    expect(processed).toHaveLength(10);
    const count2 = await drainJobs({ logger, maxDrainMs: 5000, handler: async () => {}, client: db });
    expect(count2).toBe(0); // queue empty
    void handler;
  });

  it("retries failed jobs with backoff and eventually fails them", async () => {
    const db = testDb();
    const job = await enqueue({ kind: "always_fails", payload: {} }, db);
    expect(job).not.toBeNull();
    const claimed = await claimJob("w1", db);
    expect(claimed).not.toBeNull();
    const outcome1 = await failJob(claimed!, { attempts: 1, maxAttempts: 5, id: claimed!.id }, db);
    expect(outcome1).toBe("retried");
    const pending = await db.job.findUnique({ where: { id: claimed!.id } });
    expect(pending?.status).toBe("pending");
    expect(pending?.runAt.getTime()).toBeGreaterThan(Date.now());
    // Exhaust attempts
    let attempts = 2;
    let outcome: "retried" | "failed" = "retried";
    while (outcome === "retried" && attempts <= 5) {
      await db.job.update({ where: { id: claimed!.id }, data: { runAt: new Date(Date.now() - 1000) } });
      const again = await claimJob("w1", db);
      expect(again?.id).toBe(claimed!.id);
      outcome = await failJob({ id: again!.id, attempts, maxAttempts: 5 }, new Error("boom"), db);
      attempts += 1;
    }
    expect(outcome).toBe("failed");
    const failed = await db.job.findUnique({ where: { id: claimed!.id } });
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toContain("boom");
  });

  it("dedupe key prevents duplicate pending jobs", async () => {
    const db = testDb();
    const first = await enqueue({ kind: "product_sync", payload: { productGid: "p1" }, dedupeKey: "ps:shop1:p1" }, db);
    const second = await enqueue({ kind: "product_sync", payload: { productGid: "p1" }, dedupeKey: "ps:shop1:p1" }, db);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // deduped
    const pending = await db.job.count({ where: { kind: "product_sync" } });
    expect(pending).toBe(1);
  });

  it("dedupe allows a new pending job after the first is claimed", async () => {
    const db = testDb();
    await enqueue({ kind: "product_sync", payload: {}, dedupeKey: "k1" }, db);
    const again = await enqueue({ kind: "product_sync", payload: {}, dedupeKey: "k1" }, db);
    expect(again).toBeNull();
    await claimJob("w", db);
    const third = await enqueue({ kind: "product_sync", payload: {}, dedupeKey: "k1" }, db);
    expect(third).not.toBeNull(); // first no longer pending
  });

  it("reclaims jobs stuck in running (crashed worker)", async () => {
    const db = testDb();
    await db.job.create({
      data: { kind: "x", payload: {}, status: "running", lockedAt: new Date(Date.now() - 3600_000), lockedBy: "dead" },
    });
    const reclaimed = await reclaimStuckJobs(new Date(Date.now() - 600_000), db);
    expect(reclaimed).toBe(1);
  });
});

describe("handlers", () => {
  it("validates payloads with zod", () => {
    expect(validatePayload(PRODUCT_SYNC_SCHEMA, { shopId: "s", productGid: "g", source: "webhook" })).toEqual({
      shopId: "s",
      productGid: "g",
      source: "webhook",
    });
    expect(() => validatePayload(PRODUCT_SYNC_SCHEMA, { shopId: "s" })).toThrow();
  });
  it("unregistered kinds throw (and get recorded as failures)", async () => {
    const handler = buildHandlerMap({});
    await expect(handler({ id: "x", shopId: null, kind: "nope", payload: {}, attempts: 1, maxAttempts: 1 })).rejects.toThrow(
      /no handler registered/,
    );
  });
});

describe("advisory locks (transaction-scoped)", () => {
  it("locks a shop inside a transaction and releases at commit", async () => {
    const shop = await createShop();
    const result = await withShopLock(shop.id, async (tx) => {
      const lockedAgain = await tryLockShop(shop.id, tx as never);
      expect(lockedAgain).toBe(true); // re-entrant inside same tx
      return "ok";
    });
    expect(result).toBe("ok");
    // After commit, a fresh transaction can take it again.
    const again = await withShopLock(shop.id, async () => "again");
    expect(again).toBe("again");
  });

  it("second concurrent transaction gets null (busy)", async () => {
    const db = testDb();
    const shop = await createShop();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let signalLockTaken!: () => void;
    const lockTaken = new Promise<void>((r) => (signalLockTaken = r));
    const first = db.$transaction(async (tx) => {
      const locked = await tryLockShop(shop.id, tx);
      expect(locked).toBe(true);
      signalLockTaken(); // only NOW is it safe to probe for busy
      await firstGate; // hold the transaction (and the xact lock) open
      return "first";
    });
    // Wait until the first transaction actually holds the lock, otherwise the
    // second could win the race and the assertion would be flaky.
    await lockTaken;
    const second = await withShopLock(shop.id, async () => "should-not-run");
    expect(second).toBeNull();
    releaseFirst();
    await expect(first).resolves.toBe("first");
  });
});

describe("rate limiter", () => {
  it("fixed window: allows up to limit then blocks; resets next window", async () => {
    const db = testDb();
    const key = `test-${randomUUID()}`;
    const t0 = new Date("2026-10-07T12:00:00Z");
    const r1 = await rateLimit(key, 3, 60_000, t0, );
    expect(r1.allowed).toBe(true);
    const r2 = await rateLimit(key, 3, 60_000, t0);
    expect(r2.allowed).toBe(true);
    const r3 = await rateLimit(key, 3, 60_000, t0);
    expect(r3.allowed).toBe(true);
    const r4 = await rateLimit(key, 3, 60_000, t0);
    expect(r4.allowed).toBe(false);
    const nextWindow = new Date(t0.getTime() + 61_000);
    const r5 = await rateLimit(key, 3, 60_000, nextWindow);
    expect(r5.allowed).toBe(true);
    void db;
  });
});

describe("tick", () => {
  it("is idempotent: running twice does the same work only once", async () => {
    const db = testDb();
    const shop = await createShop({ plan: "pro", timezone: "UTC", lastScanAt: new Date("2026-10-01T00:00:00Z") });
    // No scheduled scans due (scan already ran this period at Oct 1; Oct 7 12:00 UTC is a new day → due)
    const now = new Date("2026-10-07T12:00:00Z");
    const r1 = await tick({ logger, now, client: db });
    expect(r1.scansStarted).toBe(1);
    const r2 = await tick({ logger, now: new Date(now.getTime() + 1000), client: db });
    expect(r2.scansStarted).toBe(0); // already scanned this period
    expect(await db.scan.count({ where: { shopId: shop.id, trigger: "scheduled" } })).toBe(1);
  });

  it("concurrent ticks never double-start a scheduled scan", async () => {
    const db = testDb();
    await createShop({ plan: "pro", timezone: "UTC", lastScanAt: new Date("2026-10-01T00:00:00Z") });
    const now = new Date("2026-10-07T12:00:00Z");
    const results = await Promise.all([
      tick({ logger, now, client: db }),
      tick({ logger, now, client: db }),
      tick({ logger, now, client: db }),
    ]);
    const total = results.reduce((sum, r) => sum + r.scansStarted, 0);
    expect(total).toBe(1); // exactly one scan created across concurrent ticks
  });
});
