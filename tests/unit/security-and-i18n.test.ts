import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { resolveLocale } from "../../app/i18n/resolve-locale.js";
import { fallbackChain } from "../../app/i18n/config.js";
import { seal, open, tryOpen, sha256Hex, constantTimeEqual } from "../../app/lib/crypto.server.js";
import { signToken, verifyToken, timingSafeStringEqual, verifyShopifyHmac } from "../../app/lib/timing-safe.server.js";
import { computeThrottleDelayMs, isThrottled } from "../../app/lib/admin-graphql.server.js";
import { adminHttpsUrl, appBridgeUrl, productAdminPath } from "../../app/lib/admin-urls.js";
import { makeT } from "../../app/i18n/i18n.server.js";

const KEY = "v1:" + Buffer.alloc(32, 7).toString("base64");

describe("locale resolution", () => {
  it("exact supported locales", () => {
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
    expect(resolveLocale("pt-PT")).toBe("pt-PT");
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("ja")).toBe("ja");
  });
  it("regional variants map through the chain", () => {
    expect(resolveLocale("de-AT")).toBe("de");
    expect(resolveLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("fr-CA")).toBe("fr");
    expect(resolveLocale("es-MX")).toBe("es");
    expect(resolveLocale("pt")).toBe("pt-BR"); // bare pt falls back to pt-BR
  });
  it("unknown falls back to en", () => {
    expect(resolveLocale("xx-YY")).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });
  it("fallback chains ordered", () => {
    expect(fallbackChain("pt-PT")).toEqual(["pt-PT", "pt-BR", "en"]);
    expect(fallbackChain("zh-Hans-CN")).toEqual(["zh-CN", "en"]);
    expect(fallbackChain("de-AT")).toEqual(["de", "en"]);
  });
});

describe("crypto round-trip and tamper detection", () => {
  it("seals and opens", () => {
    const sealed = seal("access-token-123", KEY);
    expect(sealed.startsWith("enc:")).toBe(true);
    expect(open(sealed, KEY)).toBe("access-token-123");
  });
  it("tamper detection: auth tag failure", () => {
    const sealed = seal("secret", KEY);
    const parsed = JSON.parse(sealed.slice(4));
    parsed.ct = Buffer.from("tampered").toString("base64");
    const tampered = "enc:" + JSON.stringify(parsed);
    expect(() => open(tampered, KEY)).toThrow();
    expect(tryOpen(tampered, KEY)).toBeNull();
  });
  it("wrong key fails", () => {
    const sealed = seal("x", KEY);
    const other = "v1:" + Buffer.alloc(32, 9).toString("base64");
    expect(tryOpen(sealed, other)).toBeNull();
  });
  it("rejects unversioned or short keys", () => {
    expect(() => seal("x", "not-a-key")).toThrow();
    expect(() => seal("x", "v1:short")).toThrow();
  });
  it("hash and constant-time equal", () => {
    expect(sha256Hex("abc")).toHaveLength(64);
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "b")).toBe(false);
    expect(constantTimeEqual("a", "ab")).toBe(false);
  });
});

describe("signed tokens", () => {
  it("round-trips and expires", () => {
    const now = Date.now();
    const token = signToken("shop1:unsubscribe", KEY, 15 * 60_000, now);
    expect(verifyToken(token, KEY, now)?.payload).toBe("shop1:unsubscribe");
    expect(verifyToken(token, KEY, now + 16 * 60_000)).toBeNull();
  });
  it("tamper detection", () => {
    const token = signToken("x", KEY, 60_000);
    const parts = token.split(".");
    const evil = `${parts[0]}.${parts[1]}.${"0".repeat(64)}`;
    expect(verifyToken(evil, KEY)).toBeNull();
    expect(verifyToken("garbage", KEY)).toBeNull();
  });
  it("timing-safe string equal", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
  });
  it("shopify HMAC verification", () => {
    const secret = "shpss_x";
    const body = JSON.stringify({ id: 1 });
    const good = createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyShopifyHmac(body, good, secret)).toBe(true);
    expect(verifyShopifyHmac(body, good, "other")).toBe(false);
    expect(verifyShopifyHmac(body, undefined, secret)).toBe(false);
    expect(verifyShopifyHmac("tampered", good, secret)).toBe(false);
  });
});

describe("graphql throttle handling", () => {
  it("detects THROTTLED errors", () => {
    expect(isThrottled({ errors: [{ message: "x", extensions: { code: "THROTTLED" } }] })).toBe(true);
    expect(isThrottled({ errors: [{ message: "x" }] })).toBe(false);
    expect(isThrottled({})).toBe(false);
  });
  it("computes delay from throttleStatus", () => {
    expect(computeThrottleDelayMs({ extensions: { cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 500, restoreRate: 100 } } } })).toBe(0);
    expect(computeThrottleDelayMs({ extensions: { cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 100 } } } })).toBe(5000);
    expect(computeThrottleDelayMs({})).toBe(0);
  });
});

describe("admin URLs", () => {
  it("https URLs for csv and external links", () => {
    expect(adminHttpsUrl("myshop", "/products/123")).toBe("https://admin.shopify.com/store/myshop/products/123");
    expect(productAdminPath("myshop", "gid://shopify/Product/123")).toBe("https://admin.shopify.com/store/myshop/products/123");
  });
  it("app bridge URLs inside the app", () => {
    expect(appBridgeUrl("/products/123")).toBe("shopify://admin/products/123");
  });
});

describe("server i18n", () => {
  it("translates with placeholders and plurals", () => {
    const t = makeT("en");
    expect(t("dashboard.sinceLastVisit.newIssues", { count: 7, high: 2 })).toBe("7 new issues since your last visit (2 high)");
    expect(t("dashboard.sinceLastVisit.newIssues", { count: 1, high: 0 })).toBe("1 new issue since your last visit (none high)");
    expect(t("dashboard.sinceLastVisit.newIssues", { count: 0, high: 0 })).toBe("No new issues since your last visit (none high)");
    expect(t("issue.type.MISSING_SKU")).toBe("Missing SKU");
  });
  it("missing key returns the key", () => {
    const t = makeT("en");
    expect(t("no.such.key")).toBe("no.such.key");
  });
});

describe("CLDR plurals per locale (spec counts 0, 1, 2, 5, 1,000,000)", () => {
  const COUNTS = [0, 1, 2, 5, 1_000_000] as const;
  const LOCALES = [
    "en", "de", "fr", "es", "pt-BR", "pt-PT", "zh-CN", "ja", "it", "nl", "sv",
  ] as const;

  it.each(LOCALES)("renders a plural sentence for every count in %s", (locale) => {
    const t = makeT(locale);
    for (const count of COUNTS) {
      const out = t("dashboard.sinceLastVisit.newIssues", { count, high: 2 });
      // The sentence must mention the count (or a zero-word) and must never
      // leak an unrendered ICU arm like "{count, plural," or "#".
      expect(out).not.toMatch(/\{count,\s*plural/);
      expect(out).not.toMatch(/one\s*\{|other\s*\{/);
      expect(out).not.toContain("#");
      expect(out.length).toBeGreaterThan(10);
      const expectedNumber = new Intl.NumberFormat(locale).format(count);
      // For 0 the template renders a localized "none" word instead of 0…
      // unless the locale writes the digit (zh/ja use =0 arms with words).
      if (count !== 0 && count !== 1) {
        expect(out).toContain(expectedNumber);
      }
    }
  });

  it("zh-CN and ja use exact-match arms: one and zero read naturally", () => {
    for (const locale of ["zh-CN", "ja"] as const) {
      const t = makeT(locale);
      const zero = t("issue.list.selected", { count: 0 });
      const one = t("issue.list.selected", { count: 1 });
      const two = t("issue.list.selected", { count: 2 });
      // CJK locales have no `one` category: =0/=1 exact arms render.
      expect(zero).not.toContain("1");
      expect(one).not.toContain("2");
      expect(two).toContain(new Intl.NumberFormat(locale).format(2));
    }
  });

  it("every supported locale renders the weekly summary with a placeholder", () => {
    for (const locale of LOCALES) {
      const t = makeT(locale);
      const out = t("dashboard.weeklySummary.newIssues", { count: 3, last: 1 });
      expect(out).toContain(new Intl.NumberFormat(locale).format(3));
      expect(out).toContain(new Intl.NumberFormat(locale).format(1));
    }
  });
});
