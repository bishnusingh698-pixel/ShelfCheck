import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time compares and HMAC helpers for signed tokens:
 * tick secret, unsubscribe links, Telegram connect links, webhook HMACs.
 * All signatures use a dedicated key (SIGNING_KEY), never the API secret,
 * and every comparison is constant-time.
 */

import { sha256Hex } from "./crypto.server.js";

/** Generic string compare in constant time (length-mismatch still consumes a compare). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Timing-safe compare where one side may not be constant length (e.g. header vs secret). */
export function timingSafeSecretEqual(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeStringEqual(provided, expected);
}

/** HMAC-SHA256, hex, with a versioned key prefix already stripped by caller. */
export function hmacHex(key: string, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export interface SignedToken {
  /** Opaque, unguessable payload id (e.g. shop id + purpose). */
  payload: string;
  sig: string;
}

/** Create a signed token: `v1.<payload>.<sig>` (base64url payload). */
export function signToken(payload: string, signingKey: string, ttlMs: number, now = Date.now()): string {
  const body = JSON.stringify({ p: payload, exp: now + ttlMs } satisfies { p: string; exp: number });
  const b64 = Buffer.from(body, "utf8").toString("base64url");
  const sig = hmacHex(signingKey, b64);
  return `v1.${b64}.${sig}`;
}

/** Verify + decode a signed token. Returns null on bad signature or expiry. */
export function verifyToken(
  token: string,
  signingKey: string,
  now = Date.now(),
): { payload: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, b64, sig] = parts;
  if (!b64 || !sig) return null;
  const expected = hmacHex(signingKey, b64);
  if (!timingSafeStringEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      p: string;
      exp: number;
    };
    if (typeof parsed.exp !== "number" || parsed.exp < now) return null;
    return { payload: parsed.p };
  } catch {
    return null;
  }
}

/** One-time token helpers: only the SHA-256 hash is ever stored. */
export const hashForStorage = sha256Hex;

/** Shopify webhook HMAC: base64 HMAC-SHA256 over the raw body with the client secret. */
export function shopifyHmacBase64(rawBody: string | Buffer, apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(rawBody).digest("base64");
}

/** Constant-time verify of a Shopify webhook HMAC header against the raw body. */
export function verifyShopifyHmac(
  rawBody: string | Buffer,
  headerValue: string | undefined,
  apiSecret: string,
): boolean {
  if (!headerValue) return false;
  const computed = shopifyHmacBase64(rawBody, apiSecret);
  return timingSafeStringEqual(computed, headerValue);
}
