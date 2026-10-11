import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { db } from "../db.server.js";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { rateLimit } from "../lib/rate-limit.server.js";
import { translateTemplate, type Messages } from "../i18n/translate.js";
import { useI18n } from "../i18n/i18n.context";
import { EmptyState } from "../components/States.js";
import { ALL_ISSUE_TYPES } from "../detectors/registry.js";

/**
 * Ignore rules (spec <ui_spec> §4): list, add, delete. Scope is SKU,
 * variant, product, or vendor; the issue type and note are optional. Rules
 * keep matching issues out of the list (applied at scan time by
 * matchesIgnoreRules, app/issues/lifecycle.server.ts).
 */

const ACTION_RATE_LIMIT = 20;
const ACTION_WINDOW_MS = 60_000;

const SCOPES = ["sku", "variant", "product", "vendor"] as const;

const ACTION_SCHEMA = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("add"),
    scope: z.enum(SCOPES),
    value: z.string().trim().min(1).max(255),
    issueType: z
      .enum(ALL_ISSUE_TYPES as never as [string, ...string[]])
      .optional()
      .or(z.literal("").transform(() => undefined)),
    note: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
  }),
  z.object({ intent: z.literal("delete"), id: z.string().min(1) }),
]);

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const rules = await db.ignoreRule.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });
  return { rules };
}

export async function action({ request }: ActionFunctionArgs) {
  const shop = await requireAdminShopContext(request);

  const limit = await rateLimit(`rules-action:${shop.id}`, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
  if (!limit.allowed) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }

  const form = await request.formData();
  const parsed = ACTION_SCHEMA.safeParse({
    intent: form.get("intent"),
    scope: form.get("scope"),
    value: form.get("value"),
    issueType: form.get("issueType") || undefined,
    note: form.get("note") || undefined,
    id: form.get("id"),
  });
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (parsed.data.intent === "add") {
    await db.ignoreRule.create({
      data: {
        shopId: shop.id,
        scope: parsed.data.scope,
        value: parsed.data.value,
        issueType: parsed.data.issueType ?? null,
        note: parsed.data.note ?? null,
      },
    });
    return new Response(JSON.stringify({ ok: true, toast: "toast.ruleAdded" }), {
      headers: { "content-type": "application/json" },
    });
  }

  // Delete is shop-scoped: another shop's rule id is simply not found here.
  const deleted = await db.ignoreRule.deleteMany({ where: { id: parsed.data.id, shopId: shop.id } });
  if (deleted.count === 0) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, toast: "toast.ruleDeleted" }), {
    headers: { "content-type": "application/json" },
  });
}

export default function RulesRoute() {
  const { t } = useI18n();
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<{ ok?: boolean; toast?: string | null }>();
  const result = actionData?.ok ? actionData : null;

  return (
    <s-page heading={t("rules.title")}>
      {result?.toast ? (
        <s-box padding="base">
          <s-paragraph>{t(result.toast)}</s-paragraph>
        </s-box>
      ) : null}

      <s-section>
        <form method="post" action="/app/rules">
          <s-stack gap="base">
            <label htmlFor="rule-scope">{t("rules.scopeLabel")}</label>
            <select id="rule-scope" name="scope" defaultValue="sku">
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {t(`rules.scope.${s}`)}
                </option>
              ))}
            </select>
            <label htmlFor="rule-value">{t("rules.value")}</label>
            <input id="rule-value" name="value" type="text" required maxLength={255} />
            <label htmlFor="rule-type">{t("rules.issueType")}</label>
            <select id="rule-type" name="issueType" defaultValue="">
              <option value="">{t("rules.issueTypeAny")}</option>
              {ALL_ISSUE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`issue.type.${type}`)}
                </option>
              ))}
            </select>
            <label htmlFor="rule-note">{t("rules.note")}</label>
            <input id="rule-note" name="note" type="text" maxLength={500} />
            <input type="hidden" name="intent" value="add" />
            <s-button type="submit">{t("rules.add")}</s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section>
        {data.rules.length === 0 ? (
          <EmptyState message={t("rules.empty")} />
        ) : (
          <s-table variant="list">
            <s-table-header>
              <s-table-header-row>
                <s-table-header>{t("rules.scopeLabel")}</s-table-header>
                <s-table-header>{t("rules.value")}</s-table-header>
                <s-table-header>{t("rules.issueType")}</s-table-header>
                <s-table-header>{t("rules.note")}</s-table-header>
                <s-table-header>{t("rules.delete")}</s-table-header>
              </s-table-header-row>
            </s-table-header>
            <s-table-body>
              {data.rules.map((rule) => (
                <s-table-row key={rule.id}>
                  <s-table-cell>{t(`rules.scope.${rule.scope}`)}</s-table-cell>
                  <s-table-cell>{rule.value}</s-table-cell>
                  <s-table-cell>
                    {rule.issueType ? t(`issue.type.${rule.issueType}`) : t("rules.issueTypeAny")}
                  </s-table-cell>
                  <s-table-cell>{rule.note ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <form method="post" action="/app/rules">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={rule.id} />
                      <s-button variant="secondary" type="submit">
                        {t("rules.delete")}
                      </s-button>
                    </form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const meta: MetaFunction = ({ matches }) => {
  const layout = matches.find(
    (m) => m.id === "routes/app" && (m.data as { messages?: Messages } | null)?.messages,
  );
  const data = (layout?.data ?? null) as { locale: string; messages: Messages } | null;
  if (!data) return [];
  const screen = translateTemplate(data.messages, data.locale, "rules.title");
  return [{ title: translateTemplate(data.messages, data.locale, "app.documentTitle", { title: screen }) }];
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
