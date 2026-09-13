/**
 * tests/chests_scoring.test.js
 *
 * Behavioural suite for src/core/scoring/chests.ts resolveChestsForScore().
 * Expected values are computed by hand from the SQL contract defined in
 * gm_chests_for_score (supabase/migrations/20260914090000_war_daily_scores_and_chest_tiers.sql):
 *   chests = MAX(chests | tier.min_score <= score), malformed entries ignored,
 *   empty tiers / null or negative score resolve to 0.
 */
import { describe, it, expect } from 'vitest';
import { resolveChestsForScore } from '../src/core/scoring/chests';

const TIERS = [
  { day: 1, tier: 1, min_score: 0, chests: 1 },
  { day: 1, tier: 2, min_score: 1000, chests: 2 },
  { day: 1, tier: 3, min_score: 2500, chests: 3 },
  { day: 1, tier: 4, min_score: 5000, chests: 4 }
];

describe('resolveChestsForScore', () => {
  it('returns 0 for empty or null tier lists', () => {
    expect(resolveChestsForScore([], 1000)).toBe(0);
    expect(resolveChestsForScore(null, 1000)).toBe(0);
    expect(resolveChestsForScore(undefined, 1000)).toBe(0);
  });

  it('returns 0 when the score is below every threshold', () => {
    const noFreeTier = [
      { day: 1, tier: 1, min_score: 100, chests: 1 },
      { day: 1, tier: 2, min_score: 1000, chests: 2 }
    ];
    expect(resolveChestsForScore(noFreeTier, 0)).toBe(0);
    expect(resolveChestsForScore(noFreeTier, 99)).toBe(0);
  });

  it('unlocks the base tier on an exact hit at its threshold', () => {
    // min_score 0 is satisfied by score 0 — same rule as SQL (tier.min_score <= score).
    const base = [TIERS[0]];
    expect(resolveChestsForScore(base, 0)).toBe(1);
    expect(resolveChestsForScore(TIERS, 0)).toBe(1);
  });

  it('unlocks the tier whose threshold is reached exactly', () => {
    expect(resolveChestsForScore(TIERS, 1000)).toBe(2);
    expect(resolveChestsForScore(TIERS, 2500)).toBe(3);
    expect(resolveChestsForScore(TIERS, 5000)).toBe(4);
  });

  it('returns the highest satisfied tier for a score between thresholds', () => {
    expect(resolveChestsForScore(TIERS, 1)).toBe(1);
    expect(resolveChestsForScore(TIERS, 990)).toBe(1);
    expect(resolveChestsForScore(TIERS, 2499)).toBe(2);
    expect(resolveChestsForScore(TIERS, 5001)).toBe(4);
  });

  it('handles cumulative chest counts across many tiers', () => {
    const grid = [
      { day: 3, tier: 1, min_score: 0, chests: 0 },
      { day: 3, tier: 2, min_score: 500, chests: 5 },
      { day: 3, tier: 3, min_score: 2000, chests: 10 },
      { day: 3, tier: 4, min_score: 10000, chests: 25 }
    ];
    expect(resolveChestsForScore(grid, 750)).toBe(5);
    expect(resolveChestsForScore(grid, 2000)).toBe(10);
    expect(resolveChestsForScore(grid, 9999)).toBe(10);
    expect(resolveChestsForScore(grid, 20000)).toBe(25);
  });

  it('is order-independent (same result for shuffled tier lists)', () => {
    const shuffled = [TIERS[3], TIERS[0], TIERS[2], TIERS[1]];
    expect(resolveChestsForScore(shuffled, 4999)).toBe(
      resolveChestsForScore(TIERS, 4999)
    );
  });

  it('returns 0 for negative or non-numeric scores', () => {
    expect(resolveChestsForScore(TIERS, -5)).toBe(0);
    expect(resolveChestsForScore(TIERS, NaN)).toBe(0);
    expect(resolveChestsForScore(TIERS, Infinity)).toBe(0);
    expect(resolveChestsForScore(TIERS, null)).toBe(0);
    expect(resolveChestsForScore(TIERS, undefined)).toBe(0);
  });

  it('parses numeric string scores like the DB coercion path', () => {
    expect(resolveChestsForScore(TIERS, '1000')).toBe(2);
    expect(resolveChestsForScore(TIERS, '')).toBe(0);
  });

  it('skips malformed tiers while keeping valid ones', () => {
    const malformed = [
      null,
      { day: 9, tier: 0, min_score: NaN, chests: 3 },
      { day: 1, tier: 9, min_score: 2000, chests: 7 },
      'not-an-object',
      { day: 1, tier: 10, min_score: 0, chests: 1 }
    ];
    // SQL contract: only entries with numeric min_score/chests count.
    expect(resolveChestsForScore(malformed, 2500)).toBe(7);
    expect(resolveChestsForScore(malformed, 100)).toBe(1);
  });

  it('returns the max chest count, not the last satisfying tier', () => {
    const widthAware = [
      { day: 2, tier: 1, min_score: 0, chests: 1 },
      { day: 2, tier: 2, min_score: 10, chests: 9 },
      { day: 2, tier: 3, min_score: 1000, chests: 5 }
    ];
    // At score 50 both tier 1 and tier 2 are satisfied: 9 > 1.
    expect(resolveChestsForScore(widthAware, 50)).toBe(9);
  });
});