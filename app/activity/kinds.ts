/**
 * Client-safe activity kinds and sentence rendering (spec <in_app_alerts>).
 * This module must stay free of server imports: the Activity route uses it
 * in the component (client bundle). The DB-backed writers live in
 * events.server.ts; queries live in queries.server.ts.
 */

export const ACTIVITY_EVENT_KINDS = [
  "scan_completed",
  "scan_failed",
  "issues_changed",
  "group_regrew",
  "snoozes_reopened",
  "autotag_changed",
  "auto_tag_disabled",
  "plan_changed",
  "over_cap",
] as const;

export type ActivityEventKind = (typeof ACTIVITY_EVENT_KINDS)[number];

/**
 * Render one activity event as a full localized sentence. Pure: the
 * translator is injected so this works on both server and client, and tests
 * can exercise every kind without I/O (spec: sentences are whole, never
 * concatenated; payloads carry only counts and codes).
 *
 * The timestamp is rendered separately (activity.kind.* keys hold only the
 * event sentence) so the feed can show the date in the shop's time zone.
 */
export function activitySentence(
  t: (key: string, params?: Record<string, unknown>) => string,
  kind: ActivityEventKind,
  payload: Record<string, unknown>,
): string {
  const num = (key: string, fallback = 0): number =>
    typeof payload[key] === "number" ? (payload[key] as number) : fallback;
  const str = (key: string, fallback: string): string =>
    typeof payload[key] === "string" ? (payload[key] as string) : fallback;

  switch (kind) {
    case "scan_completed":
      return t("activity.kind.scan_completed", {
        opened: num("opened"),
        resolved: num("resolved"),
        score: num("score"),
      });
    case "scan_failed":
      return t("activity.kind.scan_failed", { code: str("code", "unknown") });
    case "issues_changed":
      return t("activity.kind.issues_changed", {
        opened: num("opened"),
        resolved: num("resolved"),
      });
    case "group_regrew":
      return t("activity.kind.group_regrew", { count: num("count") });
    case "snoozes_reopened":
      return t("activity.kind.snoozes_reopened", { count: num("count") });
    case "autotag_changed":
      return t("activity.kind.autotag_changed", { count: num("count") });
    case "auto_tag_disabled":
      return t("activity.kind.auto_tag_disabled");
    case "plan_changed":
      return t("activity.kind.plan_changed", { plan: str("plan", "free") });
    case "over_cap":
      return t("activity.kind.over_cap", { count: num("count") });
  }
}
