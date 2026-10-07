import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { env } from "../env.server";
import prisma from "../db.server";
import { seal, tryOpen } from "./crypto.server";

/**
 * Session storage that encrypts access and refresh tokens at rest
 * (AES-256-GCM, key versioned) while reusing the library's Prisma adapter
 * for row mapping. Rows written before this adapter existed (plaintext
 * tokens) still load unchanged and are re-sealed on the next store.
 */

const SEALED_PREFIX = "enc:";

const TOKEN_FIELDS = ["accessToken", "refreshToken"] as const;

function cloneSession(session: Session): Session {
  return new Session(session.toObject());
}

function sealTokens(session: Session): Session {
  const copy = cloneSession(session);
  for (const field of TOKEN_FIELDS) {
    const value = copy[field];
    if (value) copy[field] = seal(value, env.ENCRYPTION_KEY);
  }
  return copy;
}

function openTokens<T extends Session | undefined>(session: T): T {
  if (!session) return session;
  for (const field of TOKEN_FIELDS) {
    const value = session[field];
    // A sealed value that fails to open is left as-is: the ciphertext token
    // will be rejected upstream, forcing re-auth instead of silent bypass.
    if (value?.startsWith(SEALED_PREFIX)) session[field] = tryOpen(value, env.ENCRYPTION_KEY) ?? value;
  }
  return session;
}

const base = new PrismaSessionStorage(prisma);

export const encryptedSessionStorage: SessionStorage = {
  storeSession: (session) => base.storeSession(sealTokens(session)),
  loadSession: async (id) => openTokens(await base.loadSession(id)),
  deleteSession: (id) => base.deleteSession(id),
  deleteSessions: (ids) => base.deleteSessions(ids),
  findSessionsByShop: async (shop) =>
    (await base.findSessionsByShop(shop)).map((session) => openTokens(session)),
};
