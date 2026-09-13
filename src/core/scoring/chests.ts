/**
 * src/core/scoring/chests.ts
 *
 * Deterministic chest-tier scoring for the SvS / GvG daily grid.
 * Mirrors 1:1 the SQL helpers in supabase/migrations/20260914090000_war_daily_scores_and_chest_tiers.sql
 * (`gm_chests_for_score`) and supabase/migrations/20260915100000_war_aggregate_day0.sql
 * (day-0 aggregate convergence + chest fallback):
 *   - the highest tier whose min_score <= score defines the (cumulative) chest count;
 *   - malformed entries are ignored;
 *   - empty/null tiers, or a non-finite score, resolve to 0.
 *
 * The caller must filter the grid by day before calling (same contract as the
 * SQL helper, which receives a per-day tier slice). Day 0 is the aggregate
 * "Day 1 to 5 total" bucket added by the aggregate migration.
 */

import type { ChestTier } from '../../types/database';

/** Day index of the aggregate "Day 1 to 5 total" bucket in the grid. */
export const WAR_AGGREGATE_DAY = 0;

/** Per-day prep days that compose the cumulative prep total (Day 6 = PvP). */
export const PREP_DAYS: ReadonlyArray<number> = [1, 2, 3, 4, 5];

/** One score entry of the daily grid for a player. */
export interface WarPrepScore {
  day: number;
  score: number | null | undefined;
}

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

/** Default cumulative thresholds for the aggregate (day 0) prep bucket. */
const DEFAULT_AGGREGATE_THRESHOLDS: Array<{ min_score: number; chests: number }> = [
  { min_score: 0, chests: 1 },
  { min_score: 12500, chests: 2 },
  { min_score: 25000, chests: 3 }
];

/**
 * Canonical preparation total for a player (mirror of the SQL derivation in
 * gm_upsert_daily_scores): PRIORITY to the real sum over Day 1..5 when any
 * per-day score exists, falling back to the aggregate (day 0) "Day 1 to 5
 * total" otherwise. Day 6 is never part of the prep total.
 */
export function prepTotal(playerScores: WarPrepScore[] | null | undefined): number {
  if (!Array.isArray(playerScores)) return 0;
  let dailySum = 0;
  let hasDaily = false;
  let aggregate = 0;
  for (const entry of playerScores) {
    if (!entry || typeof entry !== 'object') continue;
    const day = Number(entry.day);
    if (!Number.isInteger(day)) continue;
    const raw = entry.score;
    if (raw === null || raw === undefined) continue;
    const score = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(score) || score < 0) continue;
    if (day === WAR_AGGREGATE_DAY) {
      aggregate = score;
    } else if (PREP_DAYS.indexOf(day) !== -1) {
      hasDaily = true;
      dailySum += score;
    }
  }
  return hasDaily ? dailySum : aggregate;
}

/**
 * Tier slice used to resolve chests for an aggregate (day 0) prep total.
 * Prefers an explicitly configured day-0 bucket; falls back to the day-1 slice
 * when none exists — deterministic parity with the SQL fallback inside
 * gm_upsert_daily_scores.
 */
export function aggregateTierSlice(grid: ChestTier[] | null | undefined): ChestTier[] {
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const aggregate = grid.filter((tier) => Number(tier && tier.day) === WAR_AGGREGATE_DAY);
  if (aggregate.length > 0) return aggregate;
  return grid.filter((tier) => Number(tier && tier.day) === 1);
}

/**
 * Canonical prep chests for a player (mirror of gm_upsert_daily_scores):
 *  - daily mode  → Σ over Day 1..5 of resolveChestsForScore(day slice, day score);
 *  - aggregate   → resolveChestsForScore(aggregateTierSlice(grid), aggregate score).
 * Day 6 PvP chests are not included — call resolveChestsForScore on the day-6
 * slice separately (same contract as the RPC, which stores chests per row).
 */
export function resolvePrepChests(
  grid: ChestTier[] | null | undefined,
  dailyScoresMap: Record<number, number | null | undefined> | null | undefined,
  aggregateScore: number | null | undefined
): number {
  if (!Array.isArray(grid)) return 0;
  const days: Array<{ day: number; score: number }> = [];
  if (dailyScoresMap) {
    for (const day of PREP_DAYS) {
      const raw = dailyScoresMap[day];
      if (raw === null || raw === undefined) continue;
      const score = Number(raw);
      if (!Number.isFinite(score) || score < 0) continue;
      days.push({ day, score });
    }
  }
  if (days.length > 0) {
    let total = 0;
    for (const { day, score } of days) {
      total += resolveChestsForScore(grid.filter((tier) => Number(tier.day) === day), score);
    }
    return total;
  }
  return resolveChestsForScore(aggregateTierSlice(grid), aggregateScore);
}

/**
 * Sensible fallback grid rendered when a guild has not configured any chest
 * tier yet: a day-0 cumulative bucket for the prep total plus the 3 daily
 * tiers per day (Day 1..6). Mirrors the pre-configured values shown by the
 * Guild Settings chest-tiers card. Day-0 entries are ignored by the per-day
 * slices of resolveChestsForScore (they filter by day), so existing daily
 * rendering is not affected.
 */
export function defaultChestGrid(): ChestTier[] {
  const tiers: ChestTier[] = [];
  DEFAULT_AGGREGATE_THRESHOLDS.forEach((threshold, idx) => {
    tiers.push({ day: WAR_AGGREGATE_DAY, tier: idx + 1, min_score: threshold.min_score, chests: threshold.chests });
  });
  for (let day = 1; day <= 6; day++) {
    DEFAULT_DAY_THRESHOLDS.forEach((threshold, idx) => {
      tiers.push({ day, tier: idx + 1, min_score: threshold.min_score, chests: threshold.chests });
    });
  }
  return tiers;
}