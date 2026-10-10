import { createHmac } from "node:crypto";
import { env } from "../env.server.js";
import { constantTimeEqual } from "../lib/crypto.server.js";

/**
 * Signed one-click unsubscribe tokens (spec <notifications>).
 * Token = `v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)>` where the
 * HMAC is over the prefixed payload bytes with SIGNING_KEY. Verification is
 * constant-time; malformed tokens return null (never throw).
 */

const VERSION = "v1";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(payload: string, signingKey: string): Buffer {
  return createHmac("sha256", signingKey).update(`${VERSION}:${payload}`, "utf8").digest();
}

export interface UnsubscribeClaims {
  shopId: string;
  email: string;
}

export function signUnsubscribeToken(
  claims: UnsubscribeClaims,
  signingKey: string = env.SIGNING_KEY,
): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${VERSION}.${payload}.${b64url(hmac(payload, signingKey))}`;
}

export function verifyUnsubscribeToken(
  token: string,
  signingKey: string = env.SIGNING_KEY,
): UnsubscribeClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, sig] = parts;
  let expected: Buffer;
  let claims: UnsubscribeClaims;
  try {
    expected = hmac(payload, signingKey);
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as UnsubscribeClaims;
    if (typeof parsed.shopId !== "string" || typeof parsed.email !== "string") return null;
    claims = parsed;
  } catch {
    return null;
  }
  const provided = Buffer.from(sig, "base64url");
  if (provided.length !== expected.length || !constantTimeEqual(sig, b64url(expected))) {
    return null;
  }
  return claims;
}

/** Public one-click unsubscribe URL (List-Unsubscribe header target). */
export function unsubscribeUrl(appUrl: string, token: string, locale: string): string {
  const url = new URL("/unsubscribe", appUrl);
  url.searchParams.set("token", token);
  if (locale && locale !== "en") url.searchParams.set("locale", locale);
  return url.toString();
}
