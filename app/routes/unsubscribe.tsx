import type { LoaderFunctionArgs } from "react-router";
import { makeT } from "../i18n/i18n.server.js";
import { SUPPORTED_LOCALES } from "../i18n/config.js";
import { verifyUnsubscribeToken } from "../notifications/unsubscribe.server.js";

/**
 * Public one-click unsubscribe landing page (spec <notifications>):
 * `/unsubscribe?token=<signed>&locale=<locale>`. The signed token IS the
 * authorization (HMAC with SIGNING_KEY, constant-time verified) — no session,
 * no admin auth. GET from the email client disables the digest immediately.
 */

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const requested = url.searchParams.get("locale") ?? "en";
  const locale = (SUPPORTED_LOCALES as readonly string[]).includes(requested) ? requested : "en";
  const t = makeT(locale);

  const claims = verifyUnsubscribeToken(token);
  if (!claims) {
    return { done: false as const, strings: { title: t("unsubscribe.title"), invalid: t("unsubscribe.invalid") } };
  }

  const { db } = await import("../db.server.js");
  const shop = await db.shop.findUnique({ where: { id: claims.shopId } });
  if (shop) {
    const settings = (shop.settings ?? {}) as Record<string, unknown>;
    const digest = (settings.digest ?? {}) as Record<string, unknown>;
    await db.shop.update({
      where: { id: claims.shopId },
      data: { settings: { ...settings, digest: { ...digest, enabled: false } } },
    });
  }

  return { done: true as const, strings: { title: t("unsubscribe.title"), done: t("unsubscribe.done") } };
}

export default function UnsubscribeRoute({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { done, strings } = loaderData;
  return (
    <main
      style={{
        fontFamily: "Inter, Sans-Serif",
        background: "#f6f6f7",
        color: "#30373e",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          padding: "32px",
          maxWidth: "420px",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "20px", margin: "0 0 12px" }}>{strings.title}</h1>
        <p style={{ fontSize: "14px", color: "#6d7175", margin: 0 }}>
          {done ? strings.done : strings.invalid}
        </p>
      </div>
    </main>
  );
}
