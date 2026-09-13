/**
 * src/core/scoring/chests.ts
 *
 * Deterministic chest-tier scoring for the granular SvS / GvG daily grid.
 * Mirrors 1:1 the SQL helper `public.gm_chests_for_score(p_tiers jsonb, p_score bigint)`
 * (supabase/migrations/20260914090000_war_daily_scores_and_chest_tiers.sql):
 *   - the highest tier whose min_score <= score defines the (cumulative) chest count;
 *   - malformed entries are ignored;
 *   - empty/null tiers, or a non-finite score, resolve to 0.
 *
 * The caller must filter the grid by day before calling (same contract as the
 * SQL helper, which receives a per-day tier slice).
 */

import type { ChestTier } from '../../types/database';

/**
 * Number of chests unlocked for a given score against a per-day tier slice.
 * Nullable-ish inputs are accepted for robustness; non-array / malformed
 * tiers degrade to 0 identically to gm_chests_for_score.
 */
export function resolveChestsForScore(
  tiers: ChestTier[] | null | undefined,
  score: number | string | null | undefined
): number {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  // SQL parity: a NULL score (or an empty token, like parseSafeScore) is not a
  // score — resolve to 0. Number(null) would coerce to 0 and wrongly unlock a
  // base tier at min_score 0.
  if (score === null || score === undefined || score === '') return 0;

  const numericScore = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(numericScore) || numericScore < 0) return 0;

  let resolved = 0;
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object') continue;
    const minScore = Number(tier.min_score);
    const chests = Number(tier.chests);
    if (!Number.isFinite(minScore) || !Number.isFinite(chests)) continue;
    if (minScore <= numericScore && chests > resolved) {
      resolved = chests;
    }
  }
  return resolved;
}

const DEFAULT_DAY_THRESHOLDS: Array<{ min_score: number; chests: number }> = [
  { min_score: 0, chests: 1 },
  { min_score: 2500, chests: 2 },
  { min_score: 5000, chests: 3 }
];

/**
 * Sensible fallback grid (3 cumulative tiers per day, Day 1..6) rendered when
 * a guild has not configured any chest tier yet. Mirrors the pre-configured
 * values shown by the Guild Settings chest-tiers card.
 */
export function defaultChestGrid(): ChestTier[] {
  const tiers: ChestTier[] = [];
  for (let day = 1; day <= 6; day++) {
    DEFAULT_DAY_THRESHOLDS.forEach((threshold, idx) => {
      tiers.push({ day, tier: idx + 1, min_score: threshold.min_score, chests: threshold.chests });
    });
  }
  return tiers;
}