import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { Session } from "@shopify/shopify-api";
import {
  resetDb,
  disposeTestDb,
  testDb,
  createShop,
} from "../helpers/db.js";
import { encryptedSessionStorage } from "../../app/lib/session-storage.server.js";
import { env } from "../../app/env.server.js";

const shop = "encrypt-test.myshopify.com";

function makeSession(overrides: Record<string, unknown> = {}): Session {
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "state",
    isOnline: false,
    accessToken: "shpat_secret_access_token",
    scope: "read_products,read_inventory",
    ...overrides,
  });
}

beforeAll(async () => {
  await resetDb();
  await createShop({ shopDomain: shop });
});

beforeEach(async () => {
  await testDb().session.deleteMany({});
});

afterAll(disposeTestDb);

describe("encrypting session storage", () => {
  it("stores access tokens encrypted at rest and round-trips on load", async () => {
    const session = makeSession();
    expect(await encryptedSessionStorage.storeSession(session)).toBe(true);

    const row = await testDb().session.findUnique({ where: { id: session.id } });
    expect(row?.accessToken).toBeTruthy();
    expect(row?.accessToken.startsWith("enc:")).toBe(true);
    expect(row?.accessToken).not.toContain("shpat_secret_access_token");

    const loaded = await encryptedSessionStorage.loadSession(session.id);
    expect(loaded?.accessToken).toBe("shpat_secret_access_token");
    // Loaded objects are functional Session instances (methods intact).
    expect(loaded?.isActive(undefined)).toBe(true);
  });

  it("does not mutate the caller's session object", async () => {
    const session = makeSession();
    await encryptedSessionStorage.storeSession(session);
    // The in-memory session keeps its plaintext token after storage.
    expect(session.accessToken).toBe("shpat_secret_access_token");
  });

  it("encrypts refresh tokens too and re-seals nothing on load", async () => {
    const session = makeSession({ id: `offline_${shop}_rt`, refreshToken: "shp_rt_refresh_token" });
    await encryptedSessionStorage.storeSession(session);
    const row = await testDb().session.findUnique({ where: { id: session.id } });
    expect(row?.refreshToken?.startsWith("enc:")).toBe(true);

    const loaded = await encryptedSessionStorage.loadSession(session.id);
    expect(loaded?.refreshToken).toBe("shp_rt_refresh_token");
    expect(loaded?.refreshToken?.startsWith("enc:")).toBe(false);
  });

  it("loads legacy plaintext rows unchanged (migration-safe)", async () => {
    const id = `offline_${shop}_legacy`;
    await testDb().session.create({
      data: {
        id,
        shop,
        state: "state",
        isOnline: false,
        scope: "read_products",
        accessToken: "shpat_legacy_plaintext",
      },
    });
    const loaded = await encryptedSessionStorage.loadSession(id);
    expect(loaded?.accessToken).toBe("shpat_legacy_plaintext");
  });

  it("leaves a tampered sealed value as ciphertext instead of crashing", async () => {
    const id = `offline_${shop}_tampered`;
    await testDb().session.create({
      data: {
        id,
        shop,
        state: "state",
        isOnline: false,
        accessToken: `enc:${JSON.stringify({ v: 1, iv: "AAAA", tag: "BBBB", ct: "CCCC" })}`,
      },
    });
    const loaded = await encryptedSessionStorage.loadSession(id);
    expect(loaded).toBeDefined();
    expect(loaded?.accessToken?.startsWith("enc:")).toBe(true);
    expect(loaded?.accessToken).not.toBe("shpat_anything");
  });

  it("rejects a key-version mismatch as unusable ciphertext (no silent fallback)", async () => {
    const id = `offline_${shop}_wrongversion`;
    await testDb().session.create({
      data: {
        id,
        shop,
        state: "state",
        isOnline: false,
        accessToken: `enc:${JSON.stringify({ v: 99, iv: "AAAA", tag: "BBBB", ct: "CCCC" })}`,
      },
    });
    const loaded = await encryptedSessionStorage.loadSession(id);
    // Wrong key version cannot decrypt; the row must not silently become readable.
    expect(loaded?.accessToken?.startsWith("enc:")).toBe(true);
  });

  it("findSessionsByShop returns decrypted sessions and deletes work", async () => {
    await encryptedSessionStorage.storeSession(makeSession());
    const found = await encryptedSessionStorage.findSessionsByShop(shop);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((s) => !s.accessToken?.startsWith("enc:"))).toBe(true);

    expect(await encryptedSessionStorage.deleteSession(`offline_${shop}`)).toBe(true);
    expect(await testDb().session.findUnique({ where: { id: `offline_${shop}` } })).toBeNull();
  });

  it("the sealed value never contains the key material", async () => {
    const session = makeSession({ id: `offline_${shop}_keymat` });
    await encryptedSessionStorage.storeSession(session);
    const row = await testDb().session.findUnique({ where: { id: session.id } });
    const keyMaterial = env.ENCRYPTION_KEY.split(":").slice(1).join(":");
    expect(row?.accessToken).not.toContain(keyMaterial);
  });
});
