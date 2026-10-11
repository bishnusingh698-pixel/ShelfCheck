/**
 * Snooze constants (pure, shared by server actions and the client panel).
 * The server-side DB functions live in snooze.server.ts.
 */

export const SNOOZE_DAYS = [7, 30, 90] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

export function snoozeUntil(days: SnoozeDays, now = new Date()): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

export function isSnoozeDays(value: number): value is SnoozeDays {
  return (SNOOZE_DAYS as readonly number[]).includes(value);
}
