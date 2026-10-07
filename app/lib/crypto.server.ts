import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM encryption with key versioning.
 * Envelope format: v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
 * Key material comes from env (ENCRYPTION_KEY = "v1:<material>"); the prefix
 * selects the algorithm version so keys can be rotated later (v2, v3, ...).
 */

export interface SealedValue {
  v: number; // key version (1 today; supports rotation)
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
}

function material(keyVersioned: string): { v: number; key: Buffer } {
  const [versionPart, ...rest] = keyVersioned.split(":");
  const material = rest.join(":");
  const version = Number(versionPart.replace(/^v/, ""));
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("encryption key must be versioned like v1:<material>");
  }
  const key = Buffer.from(material, "base64");
  if (key.length < 32) {
    throw new Error("encryption key material must decode to at least 32 bytes");
  }
  return { v: version, key: key.subarray(0, 32) };
}

export function seal(plaintext: string, keyVersioned: string): string {
  const { v, key } = material(keyVersioned);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const sealed: SealedValue = { v, iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
  return `enc:${JSON.stringify(sealed)}`;
}

export function open(sealedString: string, keyVersioned: string): string {
  if (!sealedString.startsWith("enc:")) {
    throw new Error("not a sealed value");
  }
  const sealed = JSON.parse(sealedString.slice(4)) as SealedValue;
  const { v, key } = material(keyVersioned);
  if (sealed.v !== v) {
    throw new Error(`key version mismatch: sealed with v${sealed.v}, configured v${v}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return pt;
}

export function tryOpen(sealedString: string, keyVersioned: string): string | null {
  try {
    return open(sealedString, keyVersioned);
  } catch {
    return null;
  }
}

/** SHA-256 hex digest of a value (used for one-time tokens; only hashes are stored). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against ourselves to keep timing flat, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
