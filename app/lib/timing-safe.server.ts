import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time compares and HMAC helpers for signed secrets: the tick
 * secret and Shopify webhook HMACs. All signatures use a dedicated key
 * (SIGNING_KEY), never the API secret, and every comparison is
 * constant-time.
 */

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
export function timingSafeSecretEqual(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeStringEqual(provided, expected);
}

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
