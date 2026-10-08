import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { BULK_SCAN_QUERY } from "./bulk-query.js";
import {
  startBulkOperation,
  readBulkOperation,
  fetchResultStream,
  type OperationStatus,
} from "./bulk-operation.server.js";
import type { AdminGraphQLExecutor } from "../lib/admin-graphql.server.js";
import { streamJsonlIntoIndex } from "./jsonl-stream.server.js";
import { detectDuplicates } from "../detectors/duplicates.server.js";
import { rowRules } from "../detectors/row-rules.js";
import { parseDetectorOptions } from "../detectors/registry.js";
import { variantCap } from "../billing/gating.js";
import type { DetectorResult } from "../detectors/types.js";
import {
  upsertIssue,
  resolveAbsentIssues,
  markIntentionalRegrowth,
  matchesIgnoreRules,
  computeIssueCounts,
  type IgnoreRuleRow,
} from "../issues/lifecycle.server.js";
import { healthScore } from "../issues/health-score.js";
import { reconcileAfterScan } from "./reconcile.server.js";
import { enqueue } from "../jobs/queue.server.js";
import { tryLockShop } from "../lib/advisory-lock.server.js";

/**
 * Scan state machine: trigger → lock → start bulk op → await (webhook first,
 * polling fallback) → stream → detect → reconcile → complete | fail.
 *
 * Every step is idempotent and crash-safe: the scan row holds the bulk
 * operation id; the finish webhook and the polling job race safely because
 * both re-check the scan status before parsing.
 */

export type ExecutorFactory = (shopId: string) => Promise<{
  graphql: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
}>;

export interface ScanFailInfo {
  errorCode: string;
  attempt: number;
}

const MAX_START_ATTEMPTS = 3;

/** Begin a scan: transition queued → running and start the bulk operation. */
export async function startScan(
  params: {
    shopId: string;
    scanId: string;
    makeExecutor: (shopId: string) => Promise<AdminGraphQLExecutor>;
    client: PrismaClient;
    logger: Logger;
    now?: Date;
  },
): Promise<{ started: boolean; bulkOperationId?: string }> {
  const { shopId, scanId, makeExecutor, client, logger } = params;
  const now = params.now ?? new Date();

  const updated = await client.scan.updateMany({
    where: { id: scanId, shopId, status: "queued" },
    data: { status: "running", startedAt: now, attempt: { increment: 1 } },
  });
  if (updated.count === 0) return { started: false }; // canceled meanwhile

  try {
    const exec = await makeExecutor(shopId);
    const op = await startBulkOperation(exec, BULK_SCAN_QUERY, logger);
    await client.scan.update({
      where: { id: scanId },
      data: { bulkOperationId: op.id },
    });
    return { started: true, bulkOperationId: op.id };
  } catch (error) {
    const scan = await client.scan.findUnique({ where: { id: scanId } });
    const attempt = scan?.attempt ?? 1;
    if (attempt >= MAX_START_ATTEMPTS) {
      await failScan(shopId, scanId, "BULK_START_FAILED", client);
    } else {
      // Retry with backoff via a delayed job.
      await client.scan.update({
        where: { id: scanId },
        data: { status: "queued" },
      });
      await enqueue(
        {
          kind: "scan_start",
          payload: { scanId },
          shopId,
          runAt: new Date(now.getTime() + 30_000 * 2 ** (attempt - 1)),
          dedupeKey: `scan_start:${scanId}`,
        },
        client,
      );
    }
    throw error;
  }
}

/** Polling fallback: check the operation; parse if terminal. */
export async function pollScan(
  params: {
    shopId: string;
    scanId: string;
    makeExecutor: (shopId: string) => Promise<AdminGraphQLExecutor>;
    client: PrismaClient;
    logger: Logger;
  },
): Promise<{ terminal: boolean; status?: OperationStatus }> {
  const { shopId, scanId, makeExecutor, client } = params;
  const scan = await client.scan.findUnique({ where: { id: scanId } });
  if (!scan || scan.status !== "running" || !scan.bulkOperationId) {
    return { terminal: false }; // finished by webhook, or canceled
  }
  const exec = await makeExecutor(shopId);
  const status = await readBulkOperation(exec, scan.bulkOperationId);
  if (!status) return { terminal: false };
  if (status.status === "COMPLETED") {
    await parseAndDetect({ shopId, scanId, status, client, logger: params.logger });
    return { terminal: true, status };
  }
  if (status.status === "FAILED" || status.status === "CANCELED" || status.status === "EXPIRED") {
    await handleFailedOperation(shopId, scanId, status, client);
    return { terminal: true, status };
  }
  return { terminal: false, status };
}

/** Handle a finished (webhook or poll) operation: stream, detect, complete. */
export async function parseAndDetect(params: {
  shopId: string;
  scanId: string;
  status: OperationStatus;
  client: PrismaClient;
  logger: Logger;
}): Promise<void> {
  const { shopId, scanId, status, client, logger } = params;
  const scan = await client.scan.findUnique({ where: { id: scanId } });
  if (!scan || !["running", "parsing"].includes(scan.status)) return; // already handled

  await client.scan.update({ where: { id: scanId }, data: { status: "parsing" } });
  if (!status.url) {
    await handleFailedOperation(shopId, scanId, { ...status, status: "FAILED", errorCode: "NO_RESULT_URL" }, client);
    return;
  }

  const shop = await client.shop.findUnique({ where: { id: shopId } });
  const plan = shop?.plan ?? "free";
  const settings = (shop?.settings ?? {}) as Record<string, unknown>;
  const cap = variantCap(plan);

  const streamResult = await streamJsonlIntoIndex({
    shopId,
    scanId,
    fetchFile: () => fetchResultStream(status.url!),
    client,
    logger,
    variantCap: cap,
  });

  await runDetection({ shopId, scanId, settings, client, logger, streamResult });
}

/** Detection phase: duplicates in SQL, row rules in code, lifecycle upserts. */
export async function runDetection(params: {
  shopId: string;
  scanId: string;
  settings: Record<string, unknown>;
  client: PrismaClient;
  logger: Logger;
  streamResult: { variantsSeen: number; overCapCount: number };
  now?: Date;
}): Promise<{ opened: number; resolved: number; regrown: number; score: number }> {
  const { shopId, scanId, client, logger, streamResult } = params;
  const now = params.now ?? new Date();

  const detectorOptions = parseDetectorOptions(params.settings);
  const rules = await client.ignoreRule.findMany({ where: { shopId } });
  const ruleRows: IgnoreRuleRow[] = rules.map((r) => ({
    scope: r.scope as IgnoreRuleRow["scope"],
    value: r.value,
    issueType: r.issueType,
  }));

  const variants = await client.variantIndex.findMany({
    where: { shopId, seenScanId: scanId },
  });

  let opened = 0;
  const findings: DetectorResult[] = [];

  // Row rules (pure) over analyzed variants. Gift-card and draft/archived
  // exclusions are applied per-check inside rowRules (see detectors/row-rules.ts).
  for (const v of variants) {
    const rowFindings = rowRules(v, detectorOptions);
    for (const f of rowFindings) {
      if (matchesIgnoreRules(f, v, ruleRows)) continue;
      const outcome = await upsertIssue(shopId, scanId, f, client, now);
      if (outcome === "opened") opened += 1;
      findings.push(f);
    }
  }

  // Duplicates (SQL, set-based). Gift cards are already excluded in SQL.
  const dupFindings = await detectDuplicates(shopId, scanId, client);
  for (const f of dupFindings) {
    if (!detectorOptions.enabledIssueTypes.has(f.type)) continue;
    const member = variants.find((v) => v.variantGid === f.variantGid);
    if (!member) continue;
    const asResult: DetectorResult = {
      type: f.type,
      severity: f.severity,
      variantGid: f.variantGid,
      productGid: f.productGid,
      groupKey: f.groupKey,
      details: f.caseOrSpaceOnly ? { case_or_space_only: true } : {},
    };
    if (matchesIgnoreRules(asResult, member as never, ruleRows)) continue;
    const outcome = await upsertIssue(shopId, scanId, asResult, client, now);
    if (outcome === "opened") opened += 1;
    findings.push(asResult);
  }

  const regrown = await markIntentionalRegrowth(shopId, findings, client);
  const resolved = await resolveAbsentIssues(shopId, scanId, client, now);

  // Reconcile: delete index rows not seen — ONLY after a fully successful scan.
  const deleted = await reconcileAfterScan(shopId, scanId, streamResult.overCapCount, client);

  const counts = await computeIssueCounts(shopId, client);
  const score = healthScore(
    { high: counts.high, medium: counts.medium, low: counts.low },
    streamResult.variantsSeen,
  );

  await client.scan.update({
    where: { id: scanId },
    data: {
      status: "completed",
      variantsSeen: streamResult.variantsSeen + streamResult.overCapCount,
      variantsAnalyzed: streamResult.variantsSeen,
      overCapCount: streamResult.overCapCount,
      healthScore: score,
      counts: {
        ...counts,
        openedThisScan: opened,
        resolvedThisScan: resolved,
        regrownGroups: regrown,
        indexRowsDeleted: deleted,
      } as never,
      finishedAt: now,
      errorCode: null,
    },
  });
  await client.shop.update({
    where: { id: shopId },
    data: { lastScanAt: now },
  });

  logger.info(
    { shopId, scanId, opened, resolved, regrown, score },
    "scan completed",
  );

  // Auto-tag runs after a completed scan only (never from webhook-driven
  // work): the fingerprint check in product-sync is the loop guard (D-31).
  if (params.settings.autoTag === true) {
    await enqueue(
      {
        kind: "autotag_run",
        payload: { shopId, scanId },
        shopId,
        dedupeKey: `autotag:${shopId}:${scanId}`,
      },
      client,
    );
  }

  // Enqueue notifications for newly opened issues (digest/alert jobs check plan).
  if (opened > 0) {
    await enqueue(
      {
        kind: "notify_new_issues",
        payload: { scanId, openedCount: opened },
        shopId,
        dedupeKey: `notify:${scanId}`,
      },
      client,
    );
  }
  return { opened, resolved, regrown, score };
}

/** Failure path with retry (spec: up to 3 attempts with backoff). */
export async function handleFailedOperation(
  shopId: string,
  scanId: string,
  status: OperationStatus,
  client: PrismaClient,
): Promise<void> {
  const scan = await client.scan.findUnique({ where: { id: scanId } });
  if (!scan || !["running", "parsing", "queued"].includes(scan.status)) return;
  const attempt = scan.attempt ?? 1;
  if (attempt < MAX_START_ATTEMPTS && status.status !== "CANCELED") {
    await client.scan.update({
      where: { id: scanId },
      data: { status: "queued", bulkOperationId: null },
    });
    await enqueue(
      {
        kind: "scan_start",
        payload: { scanId },
        shopId,
        runAt: new Date(Date.now() + 60_000 * 2 ** (attempt - 1)),
        dedupeKey: `scan_start:${scanId}`,
      },
      client,
    );
  } else {
    await failScan(shopId, scanId, status.errorCode ?? status.status, client);
  }
}

export async function failScan(
  shopId: string,
  scanId: string,
  errorCode: string,
  client: PrismaClient,
): Promise<void> {
  await client.scan.updateMany({
    where: { id: scanId, shopId, status: { in: ["queued", "running", "parsing"] } },
    data: { status: "failed", errorCode, finishedAt: new Date() },
  });
}

/** Trigger: create a scan under the shop lock; returns existing if active. */
export async function triggerScan(
  params: {
    shopId: string;
    trigger: "install" | "manual" | "scheduled";
    client: PrismaClient;
    logger: Logger;
  },
): Promise<{ scanId: string; created: boolean }> {
  const { shopId, trigger, client, logger } = params;
  return client.$transaction(async (tx) => {
    if (!(await tryLockShop(shopId, tx))) {
      const active = await tx.scan.findFirst({
        where: { shopId, status: { in: ["queued", "running", "parsing"] } },
        orderBy: { id: "desc" },
      });
      if (active) return { scanId: active.id, created: false };
    }
    const active = await tx.scan.findFirst({
      where: { shopId, status: { in: ["queued", "running", "parsing"] } },
      orderBy: { id: "desc" },
    });
    if (active) return { scanId: active.id, created: false };
    const scan = await tx.scan.create({
      data: { shopId, trigger, status: "queued" },
    });
    await enqueue(
      { kind: "scan_start", payload: { scanId: scan.id }, shopId, dedupeKey: `scan_start:${scan.id}` },
      tx,
    );
    logger.info({ shopId, scanId: scan.id, trigger }, "scan triggered");
    return { scanId: scan.id, created: true };
  });
}
