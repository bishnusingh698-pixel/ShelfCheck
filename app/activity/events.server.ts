import type { PrismaClient } from "@prisma/client";
import { db } from "../db.server.js";
import { logger } from "../lib/logger.server.js";
import type { ActivityEventKind } from "./kinds.js";

export { ACTIVITY_EVENT_KINDS, activitySentence } from "./kinds.js";
export type { ActivityEventKind } from "./kinds.js";

/**
 * Activity events (spec <in_app_alerts>): the in-app replacement for all
 * outbound messaging. Payloads hold counts and codes ONLY — never free text
 * or PII.
 *
 * Coalescing: high-volume webhook traffic (issues_changed) merges into one
 * row per shop/kind/15-minute bucket. The partial unique index on
 * (shopId, kind, coalesceBucket) makes this atomic — concurrent writers
 * race, one inserts, the loser's INSERT fails with 23505 and falls back to
 * an UPDATE that adds its counts to the winner's row.
 */

/** Webhook-driven kinds that coalesce into 15-minute buckets. */
const COALESCED_KINDS: ReadonlySet<ActivityEventKind> = new Set(["issues_changed"]);

export const COALESCE_WINDOW_MS = 15 * 60_000;

/** Rows are kept 90 days regardless of plan; the plan window only limits display. */
export const PURGE_AFTER_DAYS = 90;

export type ActivityPayload = Record<string, number | string | boolean | null>;

export interface RecordActivityInput {
  shopId: string;
  kind: ActivityEventKind;
  payload?: ActivityPayload;
  now?: Date;
  client?: PrismaClient;
}

/** Floor a timestamp to the start of its 15-minute coalescing bucket. */
export function bucketOf(at: Date, windowMs = COALESCE_WINDOW_MS): Date {
  return new Date(Math.floor(at.getTime() / windowMs) * windowMs);
}

/**
 * Record one activity event. Coalesced kinds upsert into the current bucket
 * (numeric payload fields add across events in the same bucket).
 */
export async function recordActivityEvent(input: RecordActivityInput): Promise<void> {
  const client = input.client ?? db;
  const now = input.now ?? new Date();
  const payload = input.payload ?? {};

  if (COALESCED_KINDS.has(input.kind)) {
    await upsertBucketed(client, input.shopId, input.kind, payload, now, bucketOf(now));
    return;
  }

  await client.activityEvent.create({
    data: {
      shopId: input.shopId,
      kind: input.kind,
      payload: payload as never,
      createdAt: now,
    },
  });
}

/**
 * Atomic upsert into the coalescing bucket. ON CONFLICT with an explicit
 * index predicate targets the partial unique index. Numeric payload fields
 * add across events in the same bucket; other field types overwrite.
 */
async function upsertBucketed(
  client: PrismaClient,
  shopId: string,
  kind: ActivityEventKind,
  payload: ActivityPayload,
  now: Date,
  bucket: Date,
): Promise<void> {
  const result = await client.$executeRaw`
    INSERT INTO "ActivityEvent" ("id", "shopId", "kind", "payload", "createdAt", "coalesceBucket")
    VALUES (
      gen_random_uuid()::text,
      ${shopId},
      ${kind},
      ${JSON.stringify(payload)}::jsonb,
      ${now},
      ${bucket}
    )
    ON CONFLICT ("shopId", "kind", "coalesceBucket") WHERE "coalesceBucket" IS NOT NULL
    DO UPDATE SET
      "payload" = (
        SELECT COALESCE(
          jsonb_object_agg(
            m.key,
            CASE
              WHEN jsonb_typeof(m.value) = 'number'
                   AND jsonb_typeof("ActivityEvent"."payload" -> m.key) = 'number'
              THEN to_jsonb(
                ("ActivityEvent"."payload" ->> m.key)::numeric
                + (m.value #>> '{}')::numeric
              )
              ELSE m.value
            END
          ),
          '{}'::jsonb
        )
        FROM jsonb_each(${JSON.stringify(payload)}::jsonb) AS m
      )
  `;
  if (result === 0) {
    logger.warn({ shopId, kind }, "activity bucket upsert affected no rows");
  }
}

/**
 * Webhook-driven issue change record. No-ops when nothing changed
 * ("a webhook that changes no issue records nothing").
 */
export async function recordIssuesChanged(
  shopId: string,
  delta: { opened?: number; resolved?: number; highOpened?: number },
  client: PrismaClient = db,
  now = new Date(),
): Promise<void> {
  const opened = delta.opened ?? 0;
  const resolved = delta.resolved ?? 0;
  if (opened === 0 && resolved === 0) return;
  await recordActivityEvent({
    shopId,
    kind: "issues_changed",
    payload: { opened, resolved, highOpened: delta.highOpened ?? 0 },
    client,
    now,
  });
}

/** Plan change record (app_subscriptions/update). plan is the plan key, not free text. */
export async function recordPlanChanged(
  shopId: string,
  plan: string,
  client: PrismaClient = db,
  now = new Date(),
): Promise<void> {
  await recordActivityEvent({
    shopId,
    kind: "plan_changed",
    payload: { plan },
    client,
    now,
  });
}

/**
 * Delete activity events older than PURGE_AFTER_DAYS for every shop.
 * Called from the tick; returns the number of rows deleted.
 */
export async function purgeOldActivityEvents(
  now: Date,
  client: PrismaClient = db,
): Promise<number> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * 24 * 60 * 60_000);
  const result = await client.activityEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (result.count > 0) {
    logger.info({ deleted: result.count, cutoff: cutoff.toISOString() }, "activity events purged");
  }
  return result.count;
}

