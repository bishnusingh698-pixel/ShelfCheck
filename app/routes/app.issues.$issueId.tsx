import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { z } from "zod";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Link } from "react-router";

import { db } from "../db.server.js";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { rateLimit } from "../lib/rate-limit.server.js";
import { translateTemplate, type Messages } from "../i18n/translate.js";
import { useI18n } from "../i18n/i18n.context";
import { IssueDetailPanel } from "../components/IssueDetailPanel.js";
import { EmptyState } from "../components/States.js";
import { snoozeIssue, unsnoozeIssue, isSnoozeDays } from "../issues/snooze.server.js";
import { markIntentional } from "../issues/lifecycle.server.js";
import type { IssueStatus } from "../detectors/types.js";

/** JSON responses without the deprecated react-router `json()` helper. */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}


/**
 * Issue / duplicate-group detail (spec <ui_spec> §3): every group member
 * with product, variant, "Open in Shopify admin" link and a copy-SKU
 * button; single-issue actions (snooze/ignore/intentional/resolve) with
 * undo, mirroring the list action.
 */

const STATUSES: readonly IssueStatus[] = ["open", "snoozed", "ignored", "intentional", "resolved"];

const ACTION_SCHEMA = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("snooze"),
    id: z.string().min(1),
    days: z.coerce.number().refine(isSnoozeDays),
  }),
  z.object({ intent: z.literal("unsnooze"), id: z.string().min(1) }),
  z.object({ intent: z.literal("ignore"), id: z.string().min(1) }),
  z.object({ intent: z.literal("intentional"), id: z.string().min(1) }),
  z.object({ intent: z.literal("resolve"), id: z.string().min(1) }),
  z.object({
    intent: z.literal("restore"),
    id: z.string().min(1),
    from: z.enum(STATUSES as never as [string, ...string[]]),
  }),
]);

const TOAST_BY_INTENT: Record<string, string> = {
  snooze: "toast.snoozed",
  unsnooze: "toast.undone",
  ignore: "toast.ignored",
  intentional: "toast.intentional",
  resolve: "toast.resolved",
  restore: "toast.undone",
};

export interface DetailMember {
  issueId: string;
  variantGid: string;
  productGid: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  vendor: string | null;
  status: string;
  adminUrl: string | null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const issueId = params.issueId ?? "";

  const issue = await db.issue.findFirst({ where: { id: issueId, shopId: shop.id } });
  if (!issue) return { notFound: true as const };

  // Every member of a duplicate group (spec: "for duplicate groups, every
  // member with product, variant, open-in-admin link, and a copy-SKU button").
  const memberIssues =
    issue.groupKey && issue.groupKey !== ""
      ? await db.issue.findMany({
          where: { shopId: shop.id, groupKey: issue.groupKey, type: issue.type },
          orderBy: { firstSeenAt: "asc" },
        })
      : [issue];

  const variantGids = memberIssues.map((m) => m.variantGid);
  const variants = await db.variantIndex.findMany({
    where: { shopId: shop.id, variantGid: { in: variantGids } },
  });
  const variantByGid = new Map(variants.map((v) => [v.variantGid, v]));

  const handle = shop.shopHandle ?? shop.shopDomain.replace(/\.myshopify\.com$/, "");
  const members: DetailMember[] = memberIssues.map((m) => {
    const v = variantByGid.get(m.variantGid);
    const details = (m.details ?? {}) as Record<string, unknown>;
    const productGid = m.productGid;
    return {
      issueId: m.id,
      variantGid: m.variantGid,
      productGid,
      productTitle: v?.productTitle ?? str(details.product_title),
      variantTitle: v?.variantTitle ?? str(details.variant_title),
      sku: v?.skuRaw ?? str(details.sku),
      barcode: v?.barcode ?? str(details.barcode),
      vendor: v?.vendor ?? str(details.vendor),
      status: m.status,
      adminUrl: productGid ? productUrl(handle, productGid) : null,
    };
  });

  return {
    notFound: false as const,
    issue: {
      id: issue.id,
      type: issue.type,
      severity: issue.severity,
      status: issue.status,
      groupKey: issue.groupKey === "" ? null : issue.groupKey,
      snoozedUntil: issue.snoozedUntil ? issue.snoozedUntil.toISOString() : null,
      firstSeenAt: issue.firstSeenAt.toISOString(),
      lastSeenScanId: issue.lastSeenScanId,
      intentionalMemberCount: issue.intentionalMemberCount,
      details: (issue.details ?? {}) as Record<string, unknown>,
    },
    members,
    shopHandle: handle,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function productUrl(handle: string, productGid: string): string {
  const id = productGid.replace(/^gid:\/\/shopify\/Product\//, "");
  return `https://admin.shopify.com/store/${handle}/products/${id}`;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const limit = await rateLimit(`issue-detail-action:${shop.id}`, 30, 60_000);
  if (!limit.allowed) return jsonResponse({ error: "rate_limited" }, 429);

  const form = await request.formData();
  const parsed = ACTION_SCHEMA.safeParse({
    intent: form.get("intent"),
    id: params.issueId,
    days: form.get("days") ?? undefined,
    from: form.get("from") ?? undefined,
  });
  if (!parsed.success) return jsonResponse({ error: "bad_request" }, 400);
  const { intent, id } = parsed.data;

  const existing = await db.issue.findFirst({ where: { id, shopId: shop.id }, select: { id: true, status: true, snoozedUntil: true } });
  if (!existing) return jsonResponse({ error: "not_found" }, 404);

  if (intent === "snooze") await snoozeIssue(shop.id, id, parsed.data.days, db);
  else if (intent === "unsnooze") await unsnoozeIssue(shop.id, id, db);
  else if (intent === "ignore" || intent === "resolve") {
    await db.issue.update({
      where: { id, shopId: shop.id },
      data: intent === "resolve" ? { status: "resolved", resolvedAt: new Date() } : { status: "ignored" },
    });
  } else if (intent === "intentional") {
    await markIntentional(shop.id, [id], db);
  } else {
    const status = parsed.data.from;
    await db.issue.update({
      where: { id, shopId: shop.id },
      data: { status, snoozedUntil: status === "snoozed" ? existing.snoozedUntil : null },
    });
  }

  return jsonResponse({
    ok: true,
    intent,
    toast: TOAST_BY_INTENT[intent],
    undo: intent === "restore" ? null : { id, from: existing.status },
  });
}

export default function IssueDetailRoute() {
  const { t } = useI18n();
  const data = useLoaderData<typeof loader>();

  if (data.notFound) {
    return (
      <s-page heading={t("errors.notFound")}>
        <EmptyState message={t("errors.notFound")} />
        <Link to="/app/issues">{t("issue.list.title")}</Link>
      </s-page>
    );
  }

  return <IssueDetailPanel issue={data.issue} members={data.members} />;
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
