import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { z } from "zod";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { db } from "../db.server.js";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { rateLimit } from "../lib/rate-limit.server.js";
import { translateTemplate, type Messages } from "../i18n/translate.js";
import { makeT } from "../i18n/i18n.server.js";
import { resolveLocale } from "../i18n/resolve-locale.js";
import { useI18n } from "../i18n/i18n.context";
import { IssueTable } from "../components/IssueTable.js";
import { UndoToast } from "../components/UndoToast.js";
import { EmptyState, Skeletons } from "../components/States.js";
import { parseIssueFilters, queryIssueList, ISSUE_PAGE_SIZE } from "../issues/list.server.js";
import { snoozeIssue, unsnoozeIssue, isSnoozeDays } from "../issues/snooze.server.js";
import { markIntentional } from "../issues/lifecycle.server.js";
import { ALL_ISSUE_TYPES } from "../detectors/registry.js";
import type { IssueStatus } from "../detectors/types.js";

/** JSON responses without the deprecated react-router `json()` helper. */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}


/**
 * Issues list (spec <ui_spec> §3): server-side pagination, filters, search,
 * sort, bulk actions with undo. The status filter defaults to open — the
 * punch list — and the other statuses stay reachable for un-snooze/undo.
 *
 * The action handles both single- and bulk-row intents; `restore` powers the
 * undo toast by putting each issue back to the status it had before the
 * bulk action (the client echoes back the prior statuses the action
 * returned — all states are user-settable anyway, so the echo is only a
 * convenience, never a privilege).
 */

const ACTION_RATE_LIMIT = 30;
const ACTION_WINDOW_MS = 60_000;

const STATUSES: readonly IssueStatus[] = ["open", "snoozed", "ignored", "intentional", "resolved"];

const ACTION_SCHEMA = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("snooze"),
    ids: z.array(z.string().min(1)).min(1).max(500),
    days: z.coerce.number().refine(isSnoozeDays),
  }),
  z.object({
    intent: z.literal("unsnooze"),
    ids: z.array(z.string().min(1)).min(1).max(500),
  }),
  z.object({
    intent: z.literal("ignore"),
    ids: z.array(z.string().min(1)).min(1).max(500),
  }),
  z.object({
    intent: z.literal("intentional"),
    ids: z.array(z.string().min(1)).min(1).max(500),
  }),
  z.object({
    intent: z.literal("resolve"),
    ids: z.array(z.string().min(1)).min(1).max(500),
  }),
  z.object({
    intent: z.literal("restore"),
    ids: z.array(z.string().min(1)).min(1).max(500),
    from: z.array(z.enum(STATUSES as never as [string, ...string[]])).min(1).max(500),
  }),
]);

const TOAST_BY_INTENT: Record<string, string> = {
  snooze: "toast.snoozed",
  unsnooze: "toast.undone",
  ignore: "toast.ignored",
  intentional: "toast.intentional",
  resolve: "toast.resolved",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const filters = parseIssueFilters(new URL(request.url));
  const list = await queryIssueList(db, { shopId: shop.id, plan: shop.plan, filters });

  // Echo the clamped page so the pager stays in sync with what was served.
  return { list, filters: { ...filters, page: list.page }, pageSize: ISSUE_PAGE_SIZE };
}

export async function action({ request }: ActionFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const t = makeT(resolveLocale(shop.uiLocale));

  const limit = await rateLimit(`issue-action:${shop.id}`, ACTION_RATE_LIMIT, ACTION_WINDOW_MS);
  if (!limit.allowed) return jsonResponse({ error: "rate_limited" }, 429);

  const form = await request.formData();
  const parsed = ACTION_SCHEMA.safeParse({
    intent: form.get("intent"),
    ids: form.getAll("ids").filter((v): v is string => typeof v === "string" && v !== ""),
    days: form.get("days") ?? undefined,
    from: form.getAll("from").filter((v): v is string => typeof v === "string" && v !== ""),
  });
  if (!parsed.success) return jsonResponse({ error: "bad_request" }, 400);
  const { intent, ids } = parsed.data;

  // All updates are shop-scoped: rows in other shops simply do not exist here.
  const existing = await db.issue.findMany({
    where: { id: { in: ids }, shopId: shop.id },
    select: { id: true, status: true, snoozedUntil: true },
  });
  const byId = new Map(existing.map((i) => [i.id, i]));
  const scoped = ids.filter((id) => byId.has(id));
  if (scoped.length === 0) return jsonResponse({ error: "not_found" }, 404);

  const before = scoped.map((id) => ({ id, status: byId.get(id)!.status as IssueStatus }));

  if (intent === "snooze") {
    for (const id of scoped) await snoozeIssue(shop.id, id, parsed.data.days, db);
  } else if (intent === "unsnooze") {
    for (const id of scoped) await unsnoozeIssue(shop.id, id, db);
  } else if (intent === "ignore" || intent === "resolve") {
    const status: IssueStatus = intent === "ignore" ? "ignored" : "resolved";
    await db.issue.updateMany({
      where: { id: { in: scoped }, shopId: shop.id },
      data: intent === "resolve" ? { status, resolvedAt: new Date() } : { status },
    });
  } else if (intent === "intentional") {
    await markIntentional(shop.id, scoped, db);
  } else {
    // restore: undo — put each issue back to its prior status.
    const from = parsed.data.from;
    for (let i = 0; i < scoped.length; i += 1) {
      const status = from[i] ?? "open";
      await db.issue.update({
        where: { id: scoped[i], shopId: shop.id },
        data: { status, snoozedUntil: status === "snoozed" ? byId.get(scoped[i])!.snoozedUntil : null },
      });
    }
  }

  return jsonResponse({
    ok: true,
    intent,
    toast: t(TOAST_BY_INTENT[intent] ?? "toast.saved"),
    undo: intent === "restore" ? null : { ids: scoped, from: before.map((b) => b.status) },
  });
}

export default function IssuesRoute() {
  const { t } = useI18n();
  const data = useLoaderData<typeof loader>();
  // Success action data shape; failures surface as plain Responses.
  const actionData = useActionData<{
    ok?: boolean;
    toast?: string | null;
    undo?: { ids: string[]; from: IssueStatus[] } | null;
  }>();
  const result = actionData?.ok ? actionData : null;
  const navigation = useNavigation();
  const submit = useSubmit();

  const loading = navigation.state === "loading";
  const filters = data.filters;

  /** Keep the current filters when changing one control (server-driven form). */
  const withFilter = (patch: Record<string, string>) => {
    const params = new URLSearchParams();
    const all: Record<string, string | undefined> = {
      type: filters.type,
      severity: filters.severity,
      status: filters.status,
      vendor: filters.vendor,
      q: filters.q,
      sort: filters.sort,
      ...patch,
    };
    for (const [k, v] of Object.entries(all)) if (v) params.set(k, v);
    return `/app/issues?${params.toString()}`;
  };

  const exportHref = (() => {
    const params = new URLSearchParams();
    if (filters.type) params.set("type", filters.type);
    if (filters.severity) params.set("severity", filters.severity);
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.q) params.set("q", filters.q);
    return `/app/export.csv?${params.toString()}`;
  })();

  return (
    <s-page heading={t("issue.list.title")}>
      {result && result.toast ? (
        result.undo ? (
          <UndoToast
            message={result.toast}
            onUndo={() => {
              const fd = new FormData();
              fd.set("intent", "restore");
              result.undo!.ids.forEach((id) => fd.append("ids", id));
              result.undo!.from.forEach((s) => fd.append("from", s));
              submit(fd, { method: "post" });
            }}
          />
        ) : (
          <s-box padding="base">
            <s-paragraph>{result.toast}</s-paragraph>
          </s-box>
        )
      ) : null}

      <s-section>
        <form method="get" action="/app/issues" role="search">
          <s-stack gap="base">
            <label htmlFor="issue-search">{t("issue.list.search")}</label>
            <input
              id="issue-search"
              name="q"
              type="search"
              defaultValue={filters.q ?? ""}
              placeholder={t("issue.list.search")}
            />
            <label htmlFor="issue-filter-type">{t("issue.list.filterType")}</label>
            <select id="issue-filter-type" name="type" defaultValue={filters.type ?? ""}>
              <option value="">{t("rules.issueTypeAny")}</option>
              {ALL_ISSUE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`issue.type.${type}`)}
                </option>
              ))}
            </select>
            <label htmlFor="issue-filter-severity">{t("issue.list.filterSeverity")}</label>
            <select id="issue-filter-severity" name="severity" defaultValue={filters.severity ?? ""}>
              <option value="">—</option>
              {(["high", "medium", "low"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`issue.severity.${s}`)}
                </option>
              ))}
            </select>
            <label htmlFor="issue-filter-status">{t("issue.list.filterStatus")}</label>
            <select id="issue-filter-status" name="status" defaultValue={filters.status}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`issue.status.${s}`)}
                </option>
              ))}
            </select>
            <label htmlFor="issue-filter-vendor">{t("issue.list.filterVendor")}</label>
            <select id="issue-filter-vendor" name="vendor" defaultValue={filters.vendor ?? ""}>
              <option value="">—</option>
              {data.list.vendors.map((vendor) => (
                <option key={vendor} value={vendor}>
                  {vendor}
                </option>
              ))}
            </select>
            <label htmlFor="issue-sort">{t("issue.list.sortBy")}</label>
            <select id="issue-sort" name="sort" defaultValue={filters.sort}>
              <option value="severity">{t("issue.list.sortSeverity")}</option>
              <option value="firstSeen">{t("issue.list.sortFirstSeen")}</option>
            </select>
            <input type="hidden" name="page" value="1" />
            <s-button type="submit">{t("common.save")}</s-button>
          </s-stack>
        </form>
      </s-section>

      {data.list.hidden > 0 && (
        <s-banner tone="warning">{t("issue.list.overCapHidden", { count: data.list.hidden })}</s-banner>
      )}

      {loading ? (
        <Skeletons rows={4} />
      ) : data.list.rows.length === 0 ? (
        <EmptyState message={t("issue.list.empty")} />
      ) : (
        <IssueTable
          rows={data.list.rows}
          page={data.list.page}
          pageCount={data.list.pageCount}
          total={data.list.total}
          hrefForPage={(page) => withFilter({ page: String(page) })}
          exportHref={exportHref}
        />
      )}
    </s-page>
  );
}

export const meta: MetaFunction = ({ matches }) => {
  const layout = matches.find(
    (m) => m.id === "routes/app" && (m.data as { messages?: Messages } | null)?.messages,
  );
  const data = (layout?.data ?? null) as { locale: string; messages: Messages } | null;
  if (!data) return [];
  const screen = translateTemplate(data.messages, data.locale, "issue.list.title");
  return [{ title: translateTemplate(data.messages, data.locale, "app.documentTitle", { title: screen }) }];
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
