import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "react-router";
import { db } from "../db.server.js";
import { requireAdminShopContext } from "../lib/auth.server.js";
import { canScanNow, variantCap } from "../billing/gating.js";
import { planLimits } from "../billing/plans.js";
import { localDayStart } from "../jobs/scheduler.server.js";
import { useI18n } from "../i18n/i18n.context";
import { useLoaderData } from "react-router";
import { translateTemplate, type Messages } from "../i18n/translate.js";
import { HealthScoreCard } from "../components/HealthScoreCard.js";
import { IssueCountCards } from "../components/IssueCountCards.js";
import { ScanStatus, type ScanStatusValue } from "../components/ScanStatus.js";
import { PlanUsage } from "../components/PlanUsage.js";
import { OverCapBanner } from "../components/OverCapBanner.js";
import { TrendChart } from "../components/TrendChart.js";
import { OnboardingChecklist } from "../components/OnboardingChecklist.js";
import { boundary } from "@shopify/shopify-app-react-router/server";

/**
 * Dashboard (spec <ui_spec> §1-2). All aggregates are read from the stored
 * scan row (performance target: no heavy queries per dashboard load):
 *  - health score + counts from the latest completed scan,
 *  - live status from the latest scan of any status,
 *  - trend from the last 8 completed scans' opened/resolved counters,
 *  - plan usage from variantsAnalyzed versus the plan cap,
 *  - the scan-start gate for the Scan-now button state,
 *  - onboarding checklist while no scan has ever completed.
 */

const ACTIVE_STATUSES = ["queued", "running", "parsing"];

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireAdminShopContext(request);
  const now = new Date();

  const latestScan = await db.scan.findFirst({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
  });

  const lastCompleted = await db.scan.findFirst({
    where: { shopId: shop.id, status: "completed" },
    orderBy: { createdAt: "desc" },
  });

  const recentScans = await db.scan.findMany({
    where: { shopId: shop.id, status: "completed" },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { counts: true },
  });

  const activeScan = latestScan && ACTIVE_STATUSES.includes(latestScan.status) ? latestScan : null;
  const lastScanAt = lastCompleted?.createdAt ?? shop.lastScanAt;
  const gate = canScanNow(
    {
      plan: shop.plan,
      lastScanAt,
      scansToday: await db.scan.count({
        where: { shopId: shop.id, createdAt: { gte: localDayStart(now, shop.timezone ?? "UTC") } },
      }),
    },
    "manual",
    now,
  );

  const cooldownMinutes =
    gate.reason === "cooldown" && lastScanAt
      ? Math.max(
          1,
          Math.ceil(planLimits(shop.plan).scanCooldownMinutes - (now.getTime() - lastScanAt.getTime()) / 60_000),
        )
      : undefined;

  const countsJson = (lastCompleted?.counts ?? {}) as Record<string, unknown>;
  const byType =
    typeof countsJson.byType === "object" && countsJson.byType !== null
      ? (countsJson.byType as Record<string, number>)
      : {};

  // Oldest first; each row keeps its 1-based scan number (t() renders it).
  const trend = recentScans
    .map((scan, i) => {
      const counts = (scan.counts ?? {}) as Record<string, unknown>;
      return {
        n: recentScans.length - i,
        opened: typeof counts.openedThisScan === "number" ? counts.openedThisScan : 0,
        resolved: typeof counts.resolvedThisScan === "number" ? counts.resolvedThisScan : 0,
      };
    })
    .reverse();

  return {
    scan: {
      status: (latestScan?.status ?? null) as ScanStatusValue | null,
      lastScanAt: lastCompleted?.finishedAt?.toISOString() ?? shop.lastScanAt?.toISOString() ?? null,
      canScanNow: !activeScan && gate.allowed,
      deniedReason: (activeScan ? "active" : gate.reason ?? null) as
        | "free-plan-monthly"
        | "daily-limit"
        | "cooldown"
        | "active"
        | null,
      cooldownMinutes,
      variantsAnalyzed: lastCompleted?.variantsAnalyzed ?? 0,
    },
    healthScore: lastCompleted?.healthScore ?? null,
    counts: {
      high: typeof countsJson.high === "number" ? countsJson.high : 0,
      medium: typeof countsJson.medium === "number" ? countsJson.medium : 0,
      low: typeof countsJson.low === "number" ? countsJson.low : 0,
      byType,
    },
    usage: {
      analyzed: lastCompleted?.variantsAnalyzed ?? 0,
      cap: variantCap(shop.plan),
      overCapCount: lastCompleted?.overCapCount ?? 0,
    },
    onboarding: {
      show: lastCompleted == null,
      scanRunning: activeScan != null,
    },
    trend,
  };
}

export default function Index() {
  const { t } = useI18n();
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading={t("dashboard.title")}>
      <OverCapBanner overCapCount={data.usage.overCapCount} />

      {data.onboarding.show ? (
        <OnboardingChecklist
          steps={[
            { key: "scanRunning", state: data.onboarding.scanRunning ? "running" : "todo" },
            { key: "reviewIssues", state: "todo" },
            { key: "setUpDigest", state: "todo" },
          ]}
        />
      ) : (
        <HealthScoreCard score={data.healthScore} />
      )}

      <ScanStatus scan={data.scan} />

      {!data.onboarding.show && (
        <>
          <IssueCountCards counts={data.counts} showByType={Object.keys(data.counts.byType).length > 0} />
          <PlanUsage analyzed={data.usage.analyzed} cap={data.usage.cap} />
          <TrendChart trend={data.trend} />
        </>
      )}

      <s-section>
        <s-paragraph>{t("app.tagline")}</s-paragraph>
      </s-section>
    </s-page>
  );
}

/**
 * Document title (spec: page titles are localized, never hard-coded). The
 * layout loader (routes/app) supplies locale + messages; `matches` walks up
 * the matched route tree to find it.
 */
export const meta: MetaFunction = ({ matches }) => {
  const layout = matches.find(
    (m) => m.id === "routes/app" && (m.data as { messages?: Messages } | null)?.messages,
  );
  const data = (layout?.data ?? null) as { locale: string; messages: Messages } | null;
  if (!data) return [];
  const screen = translateTemplate(data.messages, data.locale, "dashboard.title");
  return [
    { title: translateTemplate(data.messages, data.locale, "app.documentTitle", { title: screen }) },
  ];
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
