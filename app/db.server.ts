import { PrismaClient } from "@prisma/client";
import { env } from "./env.server.js";

declare global {
  var prisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
  });
}

/** Cold-start retry: Neon autosuspends after ~300 s idle; the first dial can fail. */
async function connectWithRetry(
  client: PrismaClient,
  attempts = 5,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await client.$queryRaw`SELECT 1`;
      return;
    } catch (error) {
      lastError = error;
      const delayMs = 250 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function getClient(): PrismaClient {
  globalThis.prisma ??= createClient();
  return globalThis.prisma;
}

export const db = getClient();
export { connectWithRetry };
export default db;

