import type { ActionFunctionArgs } from "react-router";
import { env } from "../env.server.js";
import { tick } from "../jobs/tick.server.js";
import { productionDrainHandler } from "../jobs/handler-map.server.js";
import { timingSafeSecretEqual } from "../lib/timing-safe.server.js";
import { rateLimit } from "../lib/rate-limit.server.js";
import { logger } from "../lib/logger.server.js";

/**
 * POST /jobs/tick — the cron entry point (cron-job.org every 10 minutes).
 *  - constant-time compared secret header,
 *  - rate-limited (10/min — cron misfires or a leaked secret must not turn
 *    into a tight loop; tick work is DB-backed and idempotent anyway),
 *  - idempotent and safe to call concurrently,
 *  - returns well within the cron service's HTTP timeout (bounded drain).
 */

const TICK_RATE_LIMIT = 10;
const TICK_WINDOW_MS = 60_000;

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const provided = request.headers.get("x-tick-secret");
  if (!timingSafeSecretEqual(provided, env.TICK_SECRET)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const limit = await rateLimit(`tick:${ip}`, TICK_RATE_LIMIT, TICK_WINDOW_MS);
  if (!limit.allowed) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const result = await tick({
      logger,
      handler: productionDrainHandler(),
      maxDrainMs: 20_000,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    logger.error({ err: error }, "tick failed");
    // The cron should keep firing; a failed tick must not 500-loop it.
    return new Response(JSON.stringify({ error: "tick_failed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}
