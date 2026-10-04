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

/** Canonical 9-tier score thresholds per day for GvG. */
export const GVG_CHEST_THRESHOLDS: Record<number, ReadonlyArray<number>> = {
  // Day 0: cumulative "Day 1 to 5 total" aggregate prep total
  0: [405000, 1625400, 2860000, 3572000, 6265000, 8420000, 11329000, 14659000, 18590000],
  // Day 1
  1: [25000, 95400, 180000, 358000, 525000, 950000, 1450000, 2020000, 3200000],
  // Day 2 to 4
  2: [76000, 306000, 536000, 612000, 1147500, 1532500, 2067000, 2757000, 3450000],
  3: [76000, 306000, 536000, 612000, 1147500, 1532500, 2067000, 2757000, 3450000],
  4: [76000, 306000, 536000, 612000, 1147500, 1532500, 2067000, 2757000, 3450000],
  // Day 5
  5: [152000, 612000, 1072000, 1378000, 2297500, 2872500, 3678000, 4368000, 5040000],
  // Day 6 (PvP)
  6: [120000, 250000, 752000, 1232000, 1572000, 2572000, 3172000, 4344000, 8500000],
};

/** Canonical 9-tier score thresholds per day for SvS. */
export const SVS_CHEST_THRESHOLDS: Record<number, ReadonlyArray<number>> = {
  // Day 0: cumulative "Day 1 to 5 total" aggregate prep total
  0: [228000, 918000, 1608000, 1913000, 2755000, 3601000, 3982000, 5132000, 6280000],
  // Day 1 to 4
  1: [38000, 153000, 268000, 306000, 459000, 613000, 689000, 919000, 1150000],
  2: [38000, 153000, 268000, 306000, 459000, 613000, 689000, 919000, 1150000],
  3: [38000, 153000, 268000, 306000, 459000, 613000, 689000, 919000, 1150000],
  4: [38000, 153000, 268000, 306000, 459000, 613000, 689000, 919000, 1150000],
  // Day 5
  5: [76000, 306000, 536000, 689000, 919000, 1149000, 1226000, 1456000, 1680000],
  // Day 6 (PvP)
  6: [100000, 400000, 700000, 800000, 1200000, 1600000, 1800000, 2400000, 3020000],
};

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
      total += resolveChestsForScore(
        grid.filter((tier) => Number(tier.day) === day),
        score
      );
    }
    return total;
  }
  return resolveChestsForScore(aggregateTierSlice(grid), aggregateScore);
}

/**
 * Sensible fallback grid rendered when a guild has not configured any chest
 * tier yet: a day-0 cumulative bucket for the prep total plus the 6 daily
 * day blocks (Day 1..6) each populated with 9 official tiers.
 * Accepts eventName ('SvS' or 'GvG', case-insensitive), defaulting to 'SvS'.
 */
export function defaultChestGrid(eventName?: 'SvS' | 'GvG' | string): ChestTier[] {
  const isGvG = typeof eventName === 'string' && eventName.toUpperCase() === 'GVG';
  const table = isGvG ? GVG_CHEST_THRESHOLDS : SVS_CHEST_THRESHOLDS;
  const tiers: ChestTier[] = [];

  for (let day = 0; day <= 6; day++) {
    const list = table[day] || [];
    list.forEach((min_score, idx) => {
      tiers.push({
        day,
        tier: idx + 1,
        min_score,
        chests: idx + 1,
      });
    });
  }

  return tiers;
}
