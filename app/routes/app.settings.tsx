import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useMatches } from "react-router";
import { z } from "zod";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { db } from "../db.server.js";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { rateLimit } from "../lib/rate-limit.server.js";
import { SHOP_SETTINGS_SCHEMA } from "../lib/shop-context.server.js";
import { translateTemplate, type Messages } from "../i18n/translate.js";
import { useI18n } from "../i18n/i18n.context";
import { resolveLocale } from "../i18n/resolve-locale.js";
import { SUPPORTED_LOCALES } from "../i18n/config.js";
import { EmptyState } from "../components/States.js";
import { LockedFeature } from "../components/States.js";
import { ALL_ISSUE_TYPES, ISSUE_REGISTRY } from "../detectors/registry.js";
import { featureEnabled } from "../billing/gating.js";

/**
 * Settings (spec <ui_spec> §5): issue-type toggles, catalog scope, weekly
 * digest, auto-tag (plan-gated, with the App Bridge optional-scope request
 * flow), and interface/notification language. Each section saves
 * independently; settings merge into the existing jsonb (never clobber).
 *
 * The auto-tag grant flow is the ONLY place that talks to App Bridge scopes
 * (shopify.scopes.request) — deliberately isolated here, per docs/api-notes.
 * The granted state itself arrives via the app/scopes_update webhook and is
 * read from the stored shop row.
 */

const ACTION_RATE_LIMIT = 20;
const ACTION_WINDOW_MS = 60_000;

const SAVE_INTENTS = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("issueTypes"), types: z.array(z.string()).max(64) }),
  z.object({
    intent: z.literal("catalog"),
    includeDraft: z.coerce.boolean(),
    includeArchived: z.coerce.boolean(),
    acceptNonGtinBarcodes: z.coerce.boolean(),
  }),
  z.object({
    intent: z.literal("digest"),
    enabled: z.coerce.boolean(),
    email: z.string().trim().email().max(255).optional().or(z.literal("").transform(() => undefined)),
    day: z.coerce.number().int().min(0).max(6),
    hour: z.coerce.number().int().min(0).max(23),
    skipWhenEmpty: z.coerce.boolean(),
  }),
  z.object({ intent: z.literal("autoTag"), enabled: z.coerce.boolean() }),
  z.object({
    intent: z.literal("language"),
    uiLocale: z.string().refine((v) => (SUPPORTED_LOCALES as readonly string[]).includes(v)),
    notifyLocale: z.string().refine((v) => (SUPPORTED_LOCALES as readonly string[]).includes(v)),
  }),
]);

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  return {
    settings: shop.settings,
    scopes: shop.scopes,
    plan: shop.plan,
    uiLocale: shop.uiLocale,
    notifyLocale: shop.notifyLocale,
    featureEnabled: {
      digest: featureEnabled(shop.plan, "digest"),
      autoTag: featureEnabled(shop.plan, "autoTag"),
      telegram: featureEnabled(shop.plan, "telegram"),
    },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const shop = await requireAdminShopContext(request);

  const limit = await rateLimit(`settings-action:${shop.id}`, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
  if (!limit.allowed) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }

  const form = await request.formData();
  const intent = form.get("intent");
  const boolean = (name: string) => form.get(name) === "on" || form.get(name) === "true";
  const parsed = SAVE_INTENTS.safeParse({
    intent,
    types: form.getAll("types").filter((v): v is string => typeof v === "string"),
    includeDraft: boolean("includeDraft"),
    includeArchived: boolean("includeArchived"),
    acceptNonGtinBarcodes: boolean("acceptNonGtinBarcodes"),
    enabled: boolean("enabled"),
    email: form.get("email") ?? undefined,
    day: form.get("day") ?? undefined,
    hour: form.get("hour") ?? undefined,
    skipWhenEmpty: boolean("skipWhenEmpty"),
    uiLocale: form.get("uiLocale") ?? undefined,
    notifyLocale: form.get("notifyLocale") ?? undefined,
  });
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const row = await db.shop.findUnique({ where: { id: shop.id } });
  if (!row) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const settings = SHOP_SETTINGS_SCHEMA.parse(row.settings ?? {});
  const data = parsed.data;

  if (data.intent === "issueTypes") {
    const valid = data.types.filter((t): t is (typeof ALL_ISSUE_TYPES)[number] =>
      (ALL_ISSUE_TYPES as string[]).includes(t),
    );
    settings.enabledIssueTypes = valid;
  } else if (data.intent === "catalog") {
    settings.includeDraft = data.includeDraft;
    settings.includeArchived = data.includeArchived;
    settings.acceptNonGtinBarcodes = data.acceptNonGtinBarcodes;
  } else if (data.intent === "digest") {
    settings.digest = {
      enabled: data.enabled,
      email: data.email,
      day: data.day,
      hour: data.hour,
      skipWhenEmpty: data.skipWhenEmpty,
    };
  } else if (data.intent === "autoTag") {
    // The scan-side gate checks the write_products scope every run; enabling
    // here is an opt-in only (spec <hard_constraints> 3/5).
    settings.autoTag = data.enabled;
  } else {
    await db.shop.update({
      where: { id: shop.id },
      data: { uiLocale: resolveLocale(data.uiLocale), notifyLocale: resolveLocale(data.notifyLocale) },
    });
    return new Response(JSON.stringify({ ok: true, toast: "toast.saved" }), {
      headers: { "content-type": "application/json" },
    });
  }

  await db.shop.update({ where: { id: shop.id }, data: { settings: settings as object } });
  return new Response(JSON.stringify({ ok: true, toast: "toast.saved" }), {
    headers: { "content-type": "application/json" },
  });
}

/** Read the harness flag from the layout match (App Bridge is absent there). */
function useHarness(): boolean {
  const matches = useMatches();
  const layout = matches.find((m) => m.id === "routes/app");
  return Boolean((layout?.data as { harness?: boolean } | undefined)?.harness);
}

function ScopeButton() {
  const { t } = useI18n();
  const shopify = useAppBridge();
  const [state, setState] = useState<"idle" | "granted" | "denied">("idle");

  if (useHarness()) return null; // no App Bridge in the UI harness

  return (
    <>
      <s-button
        variant="secondary"
        onClick={async () => {
          try {
            const res = await shopify.scopes.request(["write_products"]);
            setState(res.result === "granted-all" ? "granted" : "denied");
          } catch {
            setState("denied");
          }
        }}
      >
        {t("settings.autoTag.requestScope")}
      </s-button>
      {state === "granted" && <s-paragraph>{t("settings.autoTag.granted")}</s-paragraph>}
      {state === "denied" && <s-paragraph>{t("settings.autoTag.denied")}</s-paragraph>}
    </>
  );
}

export default function SettingsRoute() {
  const { t } = useI18n();
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<{ ok?: boolean; toast?: string | null }>();
  const result = actionData?.ok ? actionData : null;
  const hasWriteProducts = (data.scopes ?? "").split(",").includes("write_products");
  const digest = data.settings.digest;

  const localeOptions = [...SUPPORTED_LOCALES];

  return (
    <s-page heading={t("settings.title")}>
      {result?.toast ? (
        <s-box padding="base">
          <s-paragraph>{t(result.toast)}</s-paragraph>
        </s-box>
      ) : null}

      <s-section heading={t("settings.issueTypes")}>
        <s-paragraph>{t("settings.issueTypesHelp")}</s-paragraph>
        <form method="post" action="/app/settings">
          <s-stack gap="base">
            <input type="hidden" name="intent" value="issueTypes" />
            {ALL_ISSUE_TYPES.map((type) => (
              <s-stack key={type} direction="inline" gap="base">
                <input
                  type="checkbox"
                  id={`issue-type-${type}`}
                  name="types"
                  value={type}
                  defaultChecked={(data.settings.enabledIssueTypes ?? defaultEnabledList()).includes(type)}
                />
                <label htmlFor={`issue-type-${type}`}>{t(`issue.type.${type}`)}</label>
              </s-stack>
            ))}
            <s-button type="submit">{t("common.save")}</s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("settings.catalog.title")}>
        <form method="post" action="/app/settings">
          <s-stack gap="base">
            <input type="hidden" name="intent" value="catalog" />
            <input
              type="checkbox"
              id="includeDraft"
              name="includeDraft"
              defaultChecked={data.settings.includeDraft ?? true}
            />
            <label htmlFor="includeDraft">{t("settings.catalog.includeDraft")}</label>
            <input
              type="checkbox"
              id="includeArchived"
              name="includeArchived"
              defaultChecked={data.settings.includeArchived ?? false}
            />
            <label htmlFor="includeArchived">{t("settings.catalog.includeArchived")}</label>
            <input
              type="checkbox"
              id="acceptNonGtin"
              name="acceptNonGtinBarcodes"
              defaultChecked={data.settings.acceptNonGtinBarcodes ?? false}
            />
            <label htmlFor="acceptNonGtin">{t("settings.catalog.acceptNonGtin")}</label>
            <s-paragraph>{t("settings.catalog.acceptNonGtinHelp")}</s-paragraph>
            <s-button type="submit">{t("common.save")}</s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading={t("settings.digest.title")}>
        {data.featureEnabled.digest ? (
          <form method="post" action="/app/settings">
            <s-stack gap="base">
              <input type="hidden" name="intent" value="digest" />
              <input type="checkbox" id="digestEnabled" name="enabled" defaultChecked={digest?.enabled ?? false} />
              <label htmlFor="digestEnabled">{t("settings.digest.enabled")}</label>
              <label htmlFor="digestEmail">{t("settings.digest.email")}</label>
              <input id="digestEmail" name="email" type="email" defaultValue={digest?.email ?? ""} />
              <label htmlFor="digestDay">{t("settings.digest.day")}</label>
              <input id="digestDay" name="day" type="number" min={0} max={6} defaultValue={digest?.day ?? 1} />
              <label htmlFor="digestHour">{t("settings.digest.hour")}</label>
              <input id="digestHour" name="hour" type="number" min={0} max={23} defaultValue={digest?.hour ?? 9} />
              <input type="checkbox" id="digestSkip" name="skipWhenEmpty" defaultChecked={digest?.skipWhenEmpty ?? true} />
              <label htmlFor="digestSkip">{t("settings.digest.skipWhenEmpty")}</label>
              <s-button type="submit">{t("common.save")}</s-button>
            </s-stack>
          </form>
        ) : (
          <LockedFeature message={t("plans.locked.digest")} />
        )}
      </s-section>

      <s-section heading={t("settings.autoTag.title")}>
        {data.featureEnabled.autoTag ? (
          <form method="post" action="/app/settings">
            <s-stack gap="base">
              <input type="hidden" name="intent" value="autoTag" />
              <input type="checkbox" id="autoTag" name="enabled" defaultChecked={data.settings.autoTag ?? false} />
              <label htmlFor="autoTag">{t("settings.autoTag.enable")}</label>
              <s-paragraph>{t("settings.autoTag.help")}</s-paragraph>
              {hasWriteProducts ? (
                <s-badge tone="success">{t("settings.autoTag.granted")}</s-badge>
              ) : (
                <ScopeButton />
              )}
              <s-button type="submit">{t("common.save")}</s-button>
            </s-stack>
          </form>
        ) : (
          <LockedFeature message={t("plans.locked.autoTag")} />
        )}
      </s-section>

      <s-section heading={t("settings.telegram.title")}>
        {data.featureEnabled.telegram ? (
          <EmptyState message={t("settings.telegram.connectHelp")} />
        ) : (
          <LockedFeature message={t("plans.locked.telegram")} />
        )}
      </s-section>

      <s-section heading={t("settings.language.title")}>
        <form method="post" action="/app/settings">
          <s-stack gap="base">
            <input type="hidden" name="intent" value="language" />
            <label htmlFor="uiLocale">{t("settings.language.interface")}</label>
            <select id="uiLocale" name="uiLocale" defaultValue={data.uiLocale ?? "en"}>
              {localeOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <label htmlFor="notifyLocale">{t("settings.language.notifications")}</label>
            <select id="notifyLocale" name="notifyLocale" defaultValue={data.notifyLocale ?? "en"}>
              {localeOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <s-button type="submit">{t("common.save")}</s-button>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}

function defaultEnabledList(): string[] {
  return ALL_ISSUE_TYPES.filter((t) => ISSUE_REGISTRY[t].defaultEnabled);
}

export const meta: MetaFunction = ({ matches }) => {
  const layout = matches.find(
    (m) => m.id === "routes/app" && (m.data as { messages?: Messages } | null)?.messages,
  );
  const data = (layout?.data ?? null) as { locale: string; messages: Messages } | null;
  if (!data) return [];
  const screen = translateTemplate(data.messages, data.locale, "settings.title");
  return [{ title: translateTemplate(data.messages, data.locale, "app.documentTitle", { title: screen }) }];
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
