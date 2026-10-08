import type { Logger } from "pino";
import { drainJobs, type JobHandler } from "../app/jobs/queue.server.js";

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export interface WorkerOptions {
  logger: Logger;
  /** How long to sleep between drain attempts. */
  intervalMs: number;
  /** How long a single drain may take before the loop lets the tick deadline win. */
  maxDrainMs: number;
  /** The production job handler map (omitted in tests to drain nothing). */
  handler?: JobHandler;
}

/**
 * In-process job worker. Claims and runs jobs while the instance is awake to
 * keep webhook latency low. Correctness NEVER depends on this loop: `/jobs/tick`
 * drains the same queue, and job handlers are idempotent.
 */
export function startWorker(options: WorkerOptions): WorkerHandle {
  const { logger, intervalMs, maxDrainMs, handler } = options;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const loop = async () => {
    while (running) {
      try {
        const count = await drainJobs({ logger, maxDrainMs, handler });
        if (count > 0) logger.debug({ count }, "worker drained jobs");
      } catch (error) {
        logger.warn({ err: error }, "worker drain failed");
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, intervalMs);
        timer.unref?.();
      });
      void maxDrainMs; // documented bound, enforced inside drainJobs
    }
  };

  inFlight = loop().catch((error) => {
    logger.error({ err: error }, "worker loop crashed");
  });

  return {
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

export async function stopWorker(
  worker: WorkerHandle,
  { drainMs }: { drainMs: number },
): Promise<void> {
  const deadline = Date.now() + drainMs;
  await Promise.race([
    worker.stop(),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      t.unref?.();
    }),
  ]);
}
