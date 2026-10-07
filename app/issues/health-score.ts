/**
 * Health score (pure).
 * penalty = 100 * (10*high + 4*medium + 1*low) / max(1, variants_analyzed)
 * score = clamp(100 - penalty, 0, 100), rounded to integer.
 * Bands: Excellent >= 90, Good >= 75, Needs attention >= 50, Critical < 50.
 */

export type HealthBand = "excellent" | "good" | "needs_attention" | "critical";

export interface HealthCounts {
  high: number;
  medium: number;
  low: number;
}

export function healthScore(counts: HealthCounts, variantsAnalyzed: number): number {
  const penalty =
    (100 * (10 * counts.high + 4 * counts.medium + 1 * counts.low)) /
    Math.max(1, variantsAnalyzed);
  const score = 100 - penalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function healthBand(score: number): HealthBand {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 50) return "needs_attention";
  return "critical";
}
