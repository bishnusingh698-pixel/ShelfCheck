import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { useI18n } from "../i18n/i18n.context";
import { formatDateTime } from "../i18n/format";
import { translateTemplate, type Messages } from "../i18n/translate.js";
import { activityFeed, markActivitySeen, ACTIVITY_EVENT_KINDS } from "../activity/queries.server.js";
import { activitySentence, type ActivityEventKind } from "../activity/events.server.js";

/**
 * /app/activity (spec <in_app_alerts>): the activity feed replaces the v2
 * email/Telegram digest. Newest first, plan-gated window (free 7d /
 * starter 30d / pro 90d), optional kind filter. Opening this page moves the
 * activity_seen_at marker (the spec's "opens the Activity page" rule), so the
 * nav badge clears without an extra click; "Mark all as seen" does the same
 * from the dashboard, with an Undo that restores the previous marker.
 */

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind = (ACTIVITY_EVENT_KINDS as readonly string[]).includes(kindParam ?? "")
    ? (kindParam as ActivityEventKind)
    : undefined;
  const pageParam = Number(url.searchParams.get("page") ?? "1");
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const feed = await activityFeed(shop.id, shop.plan, { kind, page });

  // Opening the page marks activity seen (spec <in_app_alerts>).
  const previousSeenAt = shop.activitySeenAt?.toISOString() ?? null;
  await markActivitySeen(shop.id);

  return {
    items: feed.items.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
    totalOlder: feed.totalOlder,
    totalInWindow: feed.totalInWindow,
    page: feed.page,
    pageCount: feed.pageCount,
    windowDays: feed.windowDays,
    kinds: ACTIVITY_EVENT_KINDS,
    kind: kind ?? null,
    previousSeenAt,
    locale: shop.uiLocale ?? "en",
    timezone: shop.timezone ?? "UTC",
    upgradeUrl: "/app/plans",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "activity_seen") {
    // Capture the marker BEFORE moving it, so Undo can restore it without
    // trusting any client-supplied timestamp.
    const previous = shop.activitySeenAt?.toISOString() ?? null;
    await markActivitySeen(shop.id);
    const back = form.get("redirectTo");
    const target = typeof back === "string" && back.startsWith("/app") ? back : "/app/activity";
    const suffix = previous ? `?undo=${encodeURIComponent(previous)}` : "";
    return new Response(null, {
      status: 302,
      headers: { Location: `${target}${suffix}` },
    });
  }

  if (intent === "activity_seen_undo") {
    const raw = form.get("previousSeenAt");
    if (typeof raw === "string") {
      const previous = new Date(raw);
      // Accept only a valid, non-future timestamp: the undo value comes back
      // through the page, but restoring it can only ever re-show activity.
      if (!Number.isNaN(previous.getTime()) && previous.getTime() <= Date.now()) {
        await markActivitySeen(shop.id, undefined, previous);
      }
    }
    const back = form.get("redirectTo");
    const target = typeof back === "string" && back.startsWith("/app") ? back : "/app/activity";
    return new Response(null, { status: 302, headers: { Location: target } });
  }

  return new Response(null, { status: 302, headers: { Location: "/app/activity" } });
}

export default function ActivityPage() {
  const { t } = useI18n();
  const data = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const markSeen = () => {
    submit(
      { intent: "activity_seen", redirectTo: "/app/activity" },
      { method: "post" },
    );
  };

  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (data.kind) params.set("kind", data.kind);
    params.set("page", String(n));
    return `/app/activity?${params.toString()}`;
  };

  return (
    <s-page heading={t("activity.title")}>
      <s-section>
        <s-stack gap="base">
          <form onSubmit={(e) => { e.preventDefault(); markSeen(); }}>
            <s-button type="submit">{t("activity.markSeen")}</s-button>
          </form>

          <s-box padding="base">
            <s-paragraph>{t("activity.window", { days: data.windowDays })}</s-paragraph>
            {data.totalOlder > 0 && (
              <s-paragraph>
                {t("activity.olderHidden", { count: data.totalOlder })}{" "}
                <s-link href={data.upgradeUrl}>{t("activity.upgrade")}</s-link>
              </s-paragraph>
            )}
          </s-box>

          <s-box padding="base">
            <s-paragraph>{t("activity.filter")}</s-paragraph>
            {data.kind && (
              <s-link href="/app/activity">{t("activity.all")}</s-link>
            )}
            {data.kinds.map((kind) => (
              <s-link key={kind} href={`/app/activity?kind=${kind}`}>
                {t(`activity.filterKind.${kind}`)}
              </s-link>
            ))}
          </s-box>
        </s-stack>
      </s-section>

      <s-section>
        {data.items.length === 0 ? (
          <s-paragraph>{t("activity.empty")}</s-paragraph>
        ) : (
          <ul>
            {data.items.map((item) => (
              <li key={item.id}>
                <s-stack gap="base">
                  <s-paragraph>
                    {activitySentence(t, item.kind as ActivityEventKind, item.payload)}
                  </s-paragraph>
                  <s-badge tone="info">
                    {formatDateTime(new Date(item.createdAt), data.locale, data.timezone)}
                  </s-badge>
                </s-stack>
              </li>
            ))}
          </ul>
        )}

        {data.pageCount > 1 && (
          <s-stack direction="inline" gap="base">
            {data.page > 1 && (
              <s-link href={pageHref(data.page - 1)}>
                <s-button variant="secondary">{t("activity.previous")}</s-button>
              </s-link>
            )}
            <s-paragraph>{t("activity.pageStatus", { page: data.page, pageCount: data.pageCount })}</s-paragraph>
            {data.page < data.pageCount && (
              <s-link href={pageHref(data.page + 1)}>
                <s-button variant="secondary">{t("activity.next")}</s-button>
              </s-link>
            )}
          </s-stack>
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
  const screen = translateTemplate(data.messages, data.locale, "activity.title");
  return [
    { title: translateTemplate(data.messages, data.locale, "app.documentTitle", { title: screen }) },
  ];
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
