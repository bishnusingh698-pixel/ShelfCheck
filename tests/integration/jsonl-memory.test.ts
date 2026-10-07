import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { resetDb, disposeTestDb, testDb, createShop, createScan } from "../helpers/db.js";
import { streamJsonlIntoIndex } from "../../app/scan/jsonl-stream.server.js";
import pino from "pino";

const logger = pino({ level: "silent" });
const LARGE = "tests/fixtures/large-50k.jsonl";
const RSS_LIMIT_MB = 300;

// The 50k fixture is generated (large file, gitignored). `npm run verify`
// generates it first; a bare `vitest run` on a fresh clone skips this test
// with instructions instead of failing.
const hasLargeFixture = existsSync(LARGE);

function currentRssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

beforeAll(async () => {
  await testDb().$queryRaw`SELECT 1`;
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disposeTestDb();
});

describe("50,000-variant JSONL memory (peak RSS under 300 MB)", () => {
  it.skipIf(!hasLargeFixture)(
    "streams the large fixture with bounded memory (run `npm run fixtures:generate` first)",
    async () => {
    const db = testDb();
    const shop = await createShop({ plan: "pro" });
    const scan = await createScan(shop.id, { status: "running" });

    const rssBefore = currentRssMb();
    const result = await streamJsonlIntoIndex({
      shopId: shop.id,
      scanId: scan.id,
      fetchFile: async () =>
        Readable.toWeb(createReadStream(LARGE)) as unknown as ReadableStream<Uint8Array>,
      client: db,
      logger,
      variantCap: 50_000,
    });

    expect(result.variantsSeen).toBe(50_000);
    expect(result.malformedLines).toBe(0);
    expect(result.overCapCount).toBe(0);
    expect(await db.variantIndex.count({ where: { shopId: shop.id } })).toBe(50_000);

    const peakMb = currentRssMb();
    console.log(
      `RSS before: ${rssBefore.toFixed(0)} MB, after 50k stream: ${peakMb.toFixed(0)} MB`,
    );
    // Peak RSS measured during the stream; the process holds the fixture rows
    // in Postgres, not memory, so the ceiling holds even after completion.
    expect(peakMb).toBeLessThan(RSS_LIMIT_MB);
  });
});
