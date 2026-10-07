import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { normalizeSku } from "./normalize.js";
import { variantFingerprint, type FingerprintRow } from "./fingerprint.js";
import { classifyLine, toParsedVariant, type ParsedVariant } from "./jsonl-schema.js";
import type { Logger } from "pino";

/**
 * Streams a bulk-operation JSONL result file line by line, batches upserts of
 * 500 rows inside transactions, and never loads the file into memory
 * (Render free tier: ~512 MB).
 *
 * Child lines (media) attach to the variant that precedes them: per
 * docs/api-notes.md §3, "all nested connections appear after their parents in
 * the file", so a one-variant buffer is enough to join __parentId children.
 *
 * Variant cap: the first `variantCap` variants are upserted and analyzed;
 * every further variant is only counted in overCapCount (never silently
 * truncated — the UI shows the over-cap banner).
 */

/**
 * Rows per bulk INSERT. Spec suggests 500–1,000; measured on the 50k fixture
 * (D-20): batch 500 peaks ~300 MB RSS, batch 100 peaks ~262 MB with the same
 * 16x speedup over per-row upserts. 100 is the default for the 512 MB
 * free-tier budget; env-overridable for tuning.
 */
export const UPSERT_BATCH_SIZE = Number(process.env.UPSERT_BATCH_SIZE ?? 100);

export interface StreamResult {
  variantsSeen: number;
  malformedLines: number;
  overCapCount: number;
}

/** Read the JSONL as an async iterable of raw lines without buffering the file. */
export async function* jsonlLines(
  fetchFile: () => Promise<ReadableStream<Uint8Array>>,
): AsyncGenerator<string> {
  const body = await fetchFile();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.trim().length > 0) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) yield buffer;
}

interface BatchRow extends ParsedVariant {
  fingerprint: string;
}

/** Process the whole file: validate, join children, batch-upsert. */
export async function streamJsonlIntoIndex(params: {
  shopId: string;
  scanId: string;
  fetchFile: () => Promise<ReadableStream<Uint8Array>>;
  client: PrismaClient;
  logger: Logger;
  variantCap?: number;
}): Promise<StreamResult> {
  const { shopId, scanId, fetchFile, client, logger, variantCap } = params;
  let variantsSeen = 0;
  let malformedLines = 0;
  let overCapCount = 0;

  // Current variant buffer: children follow their parent immediately.
  let pending: ParsedVariant | null = null;
  let pendingMediaCount = 0;

  let batch: BatchRow[] = [];
  const commitBatch = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];

    // One bulk INSERT ... ON CONFLICT DO UPDATE per batch: far fewer round
    // trips (and less driver memory) than one upsert per row. Parameterized
    // via Prisma.sql — no string concatenation of values.
    const columns = Prisma.sql`("shopId","variantGid","productGid","inventoryItemId","productTitle","variantTitle","vendor","skuRaw","skuNorm","barcode","price","compareAtPrice","productStatus","isGiftCard","requiresShipping","weightPresent","costPresent","hasImage","variantCountOnProduct","tracked","inventoryPolicy","inventoryQty","publishedAnyChannel","fingerprint","seenScanId","updatedAt")`;
    const tuples = rows.map(
      (row) =>
        Prisma.sql`(${row.shopId}, ${row.variantGid}, ${row.productGid}, ${row.inventoryItemId}, ${row.productTitle}, ${row.variantTitle}, ${row.vendor}, ${row.skuRaw}, ${row.skuNorm}, ${row.barcode}, ${row.price}, ${row.compareAtPrice}, ${row.productStatus}, ${row.isGiftCard}, ${row.requiresShipping}, ${row.weightPresent}, ${row.costPresent}, ${row.hasImage}, ${row.variantCountOnProduct}, ${row.tracked}, ${row.inventoryPolicy}, ${row.inventoryQty}, ${row.publishedAnyChannel}, ${row.fingerprint}, ${scanId}, ${new Date()})`,
    );
    await client.$executeRaw`
      INSERT INTO "VariantIndex" ${columns} VALUES ${Prisma.join(tuples)}
      ON CONFLICT ("shopId","variantGid") DO UPDATE SET
        "productGid" = EXCLUDED."productGid",
        "inventoryItemId" = EXCLUDED."inventoryItemId",
        "productTitle" = EXCLUDED."productTitle",
        "variantTitle" = EXCLUDED."variantTitle",
        "vendor" = EXCLUDED."vendor",
        "skuRaw" = EXCLUDED."skuRaw",
        "skuNorm" = EXCLUDED."skuNorm",
        "barcode" = EXCLUDED."barcode",
        "price" = EXCLUDED."price",
        "compareAtPrice" = EXCLUDED."compareAtPrice",
        "productStatus" = EXCLUDED."productStatus",
        "isGiftCard" = EXCLUDED."isGiftCard",
        "requiresShipping" = EXCLUDED."requiresShipping",
        "weightPresent" = EXCLUDED."weightPresent",
        "costPresent" = EXCLUDED."costPresent",
        "hasImage" = EXCLUDED."hasImage",
        "variantCountOnProduct" = EXCLUDED."variantCountOnProduct",
        "tracked" = EXCLUDED."tracked",
        "inventoryPolicy" = EXCLUDED."inventoryPolicy",
        "inventoryQty" = EXCLUDED."inventoryQty",
        "publishedAnyChannel" = EXCLUDED."publishedAnyChannel",
        "fingerprint" = EXCLUDED."fingerprint",
        "seenScanId" = EXCLUDED."seenScanId",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  };

  /** Finish the buffered variant: analyze (under cap) or count as over cap. */
  const finishPending = async () => {
    if (!pending) return;
    pending.hasImage = pendingMediaCount > 0;
    if (variantCap == null || variantsSeen < variantCap) {
      variantsSeen += 1;
      const skuNorm = pending.skuRaw == null ? "" : normalizeSku(pending.skuRaw);
      const fpRow: FingerprintRow = {
        skuRaw: pending.skuRaw,
        barcode: pending.barcode,
        price: pending.price,
        compareAtPrice: pending.compareAtPrice,
        productStatus: pending.productStatus,
        isGiftCard: pending.isGiftCard,
        requiresShipping: pending.requiresShipping,
        weightPresent: pending.weightPresent,
        costPresent: pending.costPresent,
        hasImage: pending.hasImage,
        variantCountOnProduct: pending.variantCountOnProduct,
        tracked: pending.tracked,
        inventoryPolicy: pending.inventoryPolicy,
        inventoryQty: pending.inventoryQty,
        publishedAnyChannel: pending.publishedAnyChannel,
      };
      batch.push({
        ...pending,
        skuNorm,
        fingerprint: variantFingerprint(fpRow),
      });
      if (batch.length >= UPSERT_BATCH_SIZE) await commitBatch();
    } else {
      overCapCount += 1;
    }
    pending = null;
    pendingMediaCount = 0;
  };

  for await (const line of jsonlLines(fetchFile)) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const classified = classifyLine(parsedJson);
    if (classified == null) {
      malformedLines += 1;
      continue;
    }
    if ("product" in classified) {
      // New variant line: finish the previous one first.
      await finishPending();
      pending = toParsedVariant(classified, shopId, 0);
      pendingMediaCount = 0;
    } else if (pending && classified.__parentId === pending.variantGid) {
      // Media child line of the buffered variant.
      pendingMediaCount += 1;
    }
  }
  await finishPending();
  await commitBatch();

  if (overCapCount > 0) {
    logger.info({ shopId, overCapCount, cap: variantCap }, "variant cap reached; tail not analyzed");
  }
  if (malformedLines > 0) {
    logger.warn({ shopId, malformedLines }, "malformed JSONL lines skipped");
  }
  return { variantsSeen, malformedLines, overCapCount };
}
