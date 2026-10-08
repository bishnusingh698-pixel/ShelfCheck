import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { variantFingerprint } from "../scan/fingerprint.js";
import { rowRules } from "../detectors/row-rules.js";
import { parseDetectorOptions } from "../detectors/registry.js";
import type { DetectorResult } from "../detectors/types.js";
import { upsertIssue } from "../issues/lifecycle.server.js";
import { featureEnabled } from "../billing/gating.js";
import { logger } from "../lib/logger.server.js";

/**
 * Inventory watcher. `inventory_levels/update` carries an inventory_item_id,
 * NOT a variant id (spec <known_pitfalls>): the handler maps the item to its
 * variants through variant_index.inventoryItemId, coalesces repeated updates
 * per item, and re-evaluates ONLY PUBLISHED_ZERO_INVENTORY.
 */

export const INVENTORY_COALESCE_MS = 5_000;

/** Per-shop throttle: a shop may run at most this many inventory syncs per hour. */
export const INVENTORY_SYNC_PER_SHOP_PER_HOUR = 240;

export interface InventorySyncResult {
  variants: number;
  opened: number;
  resolved: number;
  skipped?: "free-plan" | "throttled" | "no-variants";
}

/** Apply one inventory update to the mapped variants and re-check the one rule. */
export async function syncInventoryItem(
  params: {
    shopId: string;
    inventoryItemId: string;
    available: number | null;
    client: PrismaClient;
    log?: Logger;
    now?: Date;
  },
): Promise<InventorySyncResult> {
  const { shopId, inventoryItemId, available, client } = params;
  const log = params.log ?? logger;
  const now = params.now ?? new Date();

  const shop = await client.shop.findUnique({ where: { id: shopId } });
  if (!shop || shop.uninstalledAt) {
    return { variants: 0, opened: 0, resolved: 0, skipped: "no-variants" };
  }
  if (!featureEnabled(shop.plan, "watchers")) {
    log.debug({ shopId }, "inventory sync skipped: watchers not on plan");
    return { variants: 0, opened: 0, resolved: 0, skipped: "free-plan" };
  }

  const variants = await client.variantIndex.findMany({
    where: { shopId, inventoryItemId },
  });
  if (variants.length === 0) {
    return { variants: 0, opened: 0, resolved: 0, skipped: "no-variants" };
  }

  const settings = (shop.settings ?? {}) as Record<string, unknown>;
  const options = parseDetectorOptions(settings);

  let opened = 0;
  const nowFiring = new Set<string>();
  for (const variant of variants) {
    const updated = {
      ...variant,
      inventoryQty: available,
      fingerprint: variantFingerprint({ ...variant, inventoryQty: available }),
    };
    await client.variantIndex.update({
      where: { shopId_variantGid: { shopId, variantGid: variant.variantGid } },
      data: { inventoryQty: available, fingerprint: updated.fingerprint, updatedAt: now },
    });
    if (!options.enabledIssueTypes.has("PUBLISHED_ZERO_INVENTORY")) continue;
    const findings: DetectorResult[] = rowRules(updated, options).filter(
      (f) => f.type === "PUBLISHED_ZERO_INVENTORY",
    );
    for (const f of findings) {
      nowFiring.add(`${f.type}\u0000${f.variantGid}`);
      const outcome = await upsertIssue(shopId, `webhook:${now.getTime()}`, f, client, now);
      if (outcome === "opened") opened += 1;
    }
  }

  // Resolve PUBLISHED_ZERO_INVENTORY issues that stopped firing for these variants.
  let resolvedCount = 0;
  const stale = await client.issue.findMany({
    where: {
      shopId,
      type: "PUBLISHED_ZERO_INVENTORY",
      variantGid: { in: variants.map((v) => v.variantGid) },
      status: { in: ["open", "snoozed"] },
    },
  });
  for (const row of stale) {
    if (nowFiring.has(`PUBLISHED_ZERO_INVENTORY\u0000${row.variantGid}`)) continue;
    await client.issue.update({
      where: { id: row.id },
      data: { status: "resolved", resolvedAt: now },
    });
    resolvedCount += 1;
  }

  log.info(
    { shopId, inventoryItemId, variants: variants.length, opened, resolved: resolvedCount },
    "inventory sync complete",
  );
  return { variants: variants.length, opened, resolved: resolvedCount };
}
