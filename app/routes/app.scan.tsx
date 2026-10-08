import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { db } from "../db.server.js";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { canScanNow, variantCap } from "../billing/gating.js";
import { planLimits } from "../billing/plans.js";
import { enqueue, isUniqueViolation, isRecordNotFound } from "../jobs/queue.server.js";
import { rateLimit } from "../lib/rate-limit.server.js";
import { makeT } from "../i18n/i18n.server.js";
import { resolveLocale } from "../i18n/resolve-locale.js";
import { localDayStart } from "../jobs/scheduler.server.js";

/**
 * app.scan resource route (spec <file_layout>):
 *  - POST: start a manual scan. Gated by canScanNow (plan, cooldown, daily
 *    limit) and by "one active scan per shop" (the partial unique index is
 *    the real guard; the pre-check only gives a nicer message). Rate-limited
 *    like every mutation.
 *  - GET: the latest scan's status for the dashboard's live status line.
 */

const START_RATE_LIMIT = 6;
const START_WINDOW_MS = 60_000;

const ACTIVE_STATUSES = ["queued", "running", "parsing"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const START_INTENT_SCHEMA = z.object({ intent: z.literal("start") });

/** The shop-specific inputs for canScanNow plus a human cooldown remainder. */
async function scanGate(shop: { id: string; plan: string; timezone: string | null; lastScanAt: Date | null }, now: Date) {
  const active = await db.scan.findFirst({
    where: { shopId: shop.id, status: { in: ACTIVE_STATUSES } },
    select: { id: true },
  });
  const lastCompleted = await db.scan.findFirst({
    where: { shopId: shop.id, status: "completed" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const lastScanAt = lastCompleted?.createdAt ?? shop.lastScanAt;

  const decision = canScanNow(
    {
      plan: shop.plan,
      lastScanAt,
      scansToday: await db.scan.count({
        where: { shopId: shop.id, createdAt: { gte: localDayStart(now, shop.timezone ?? "UTC") } },
      }),
    },
    "manual",
    now,
  );

  let cooldownMinutes: number | undefined;
  if (decision.reason === "cooldown" && lastScanAt) {
    const limits = planLimits(shop.plan);
    const elapsedMinutes = (now.getTime() - lastScanAt.getTime()) / 60_000;
    cooldownMinutes = Math.max(1, Math.ceil(limits.scanCooldownMinutes - elapsedMinutes));
  }

  return {
    active: active != null,
    decision,
    cooldownMinutes,
    lastScanAt,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const t = makeT(resolveLocale(shop.uiLocale));

  const limit = await rateLimit(`scan-start:${shop.id}`, START_RATE_LIMIT, START_WINDOW_MS);
  if (!limit.allowed) return json({ error: "rate_limited" }, 429);

  const form = await request.formData();
  const parsed = START_INTENT_SCHEMA.safeParse({ intent: form.get("intent") });
  if (!parsed.success) return json({ error: "bad_intent" }, 400);

  const gate = await scanGate(shop, new Date());
  if (gate.active) return json({ error: "denied", reason: "active" }, 409);
  if (!gate.decision.allowed) {
    return json({ error: "denied", reason: gate.decision.reason, cooldownMinutes: gate.cooldownMinutes }, 409);
  }

  try {
    const scan = await db.scan.create({
      data: { shopId: shop.id, trigger: "manual", status: "queued" },
    });
    await enqueue(
      { kind: "scan_start", payload: { scanId: scan.id }, shopId: shop.id, dedupeKey: `scan_start:${scan.id}` },
      db,
    );
    return json({ ok: true, scanId: scan.id, message: t("scan.started") });
  } catch (error) {
    if (isUniqueViolation(error)) return json({ error: "denied", reason: "active" }, 409);
    if (isRecordNotFound(error)) return json({ error: "not_found" }, 404);
    throw error;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);

  const scan = await db.scan.findFirst({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      variantsAnalyzed: true,
      overCapCount: true,
      healthScore: true,
      counts: true,
    },
  });

  const gate = await scanGate(shop, new Date());

  return json({
    scan: scan
      ? {
          id: scan.id,
          status: scan.status,
          lastScanAt: (scan.status === "completed" ? scan.finishedAt : gate.lastScanAt)?.toISOString() ?? null,
          variantsAnalyzed: scan.variantsAnalyzed,
        }
      : null,
    canScanNow: !gate.active && gate.decision.allowed,
    deniedReason: gate.active ? "active" : gate.decision.reason ?? null,
    cooldownMinutes: gate.cooldownMinutes,
    variantCap: variantCap(shop.plan),
  });
}
