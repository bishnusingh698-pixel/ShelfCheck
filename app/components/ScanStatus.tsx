import { useFetcher, useSubmit } from "react-router";
import { useEffect } from "react";
import { useI18n } from "../i18n/i18n.context";
import { formatRelativeTime } from "../i18n/format";

export type ScanStatusValue = "queued" | "running" | "parsing" | "completed" | "failed" | "canceled";

export interface ScanStatusData {
  status: ScanStatusValue | null;
  lastScanAt: Date | string | null;
  canScanNow: boolean;
  deniedReason?: "free-plan-monthly" | "daily-limit" | "cooldown" | "active" | null;
  cooldownMinutes?: number;
  variantsAnalyzed?: number | null;
}

const DENIED_MESSAGE_KEY: Record<string, string> = {
  "free-plan-monthly": "scan.denied.free",
  "daily-limit": "scan.denied.dailyLimit",
  cooldown: "scan.denied.cooldown",
  active: "scan.denied.active",
};

const POLL_INTERVAL_MS = 10_000;

/**
 * Live scan status + Scan now button (spec <ui_spec> §2). Starting posts to
 * the app.scan resource route via useSubmit; while a scan is active the
 * status line polls the same route with useFetcher so progress is visible
 * without a manual reload.
 */
export function ScanStatus({ scan }: { scan: ScanStatusData }) {
  const { t, locale } = useI18n();
  const submit = useSubmit();
  const fetcher = useFetcher<{ scan: { status: ScanStatusValue; lastScanAt: string | null } | null }>();

  const live = fetcher.data?.scan;
  const status = live?.status ?? scan.status;
  const lastScanAt = scan.lastScanAt ? new Date(scan.lastScanAt) : null;
  const active = status === "queued" || status === "running" || status === "parsing";

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (fetcher.state === "idle") fetcher.load("/app/scan");
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, fetcher]);

  const startScan = () => {
    submit(new URLSearchParams({ intent: "start" }), { method: "post", action: "/app/scan" });
  };

  return (
    <s-section heading={t("dashboard.scan.title")}>
      {active && <s-badge tone="info">{t(`dashboard.scan.status.${status}`)}</s-badge>}
      {status === "failed" && (
        <s-banner tone="critical" heading={t("dashboard.scan.status.failed")}>
          {t("dashboard.scan.failedBody")}
        </s-banner>
      )}
      {status === "canceled" && <s-badge tone="warning">{t("dashboard.scan.status.canceled")}</s-badge>}
      <s-paragraph>
        {lastScanAt
          ? t("dashboard.scan.lastScanAt", { time: formatRelativeTime(lastScanAt, locale) })
          : t("dashboard.scan.never")}
      </s-paragraph>
      {scan.variantsAnalyzed != null && scan.variantsAnalyzed > 0 && (
        <s-paragraph>{t("dashboard.scan.variants", { count: scan.variantsAnalyzed })}</s-paragraph>
      )}
      {scan.canScanNow ? (
        <s-button onClick={startScan}>{t("dashboard.scan.runNow")}</s-button>
      ) : scan.deniedReason ? (
        <s-paragraph>
          {scan.deniedReason === "cooldown" && scan.cooldownMinutes
            ? t("dashboard.scan.cooldown", { minutes: scan.cooldownMinutes })
            : t(DENIED_MESSAGE_KEY[scan.deniedReason] ?? "scan.denied.active")}
        </s-paragraph>
      ) : null}
    </s-section>
  );
}
