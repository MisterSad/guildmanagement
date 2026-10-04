/**
 * tests/war_aggregate_day0.test.js
 *
 * Lot 1 of the SvS/GvG day-0 aggregation (migration 20260915100000):
 *   - SQL: day CHECKs widened to 0..6, gm_upsert_daily_scores accepts day 0..6
 *     with a transactional convergence rule (aggregate wins, day 6 untouched),
 *     cache derivation reads day IN (0..5), chest fallback to the day-1 slice;
 *   - TS mirror: src/core/scoring/chests.ts resolvePrepChests / prepTotal /
 *     aggregateTierSlice / defaultChestGrid parity with the SQL contract;
 *   - non-regression of resolveChestsForScore;
 *   - member-portal rejects direct score_prep writes on war sessions.
 */
import { describe, it, expect } from 'vitest';
import { edgeSource } from './helpers/edge-source.js';
import fs from 'fs';
import path from 'path';
import {
  WAR_AGGREGATE_DAY,
  PREP_DAYS,
  resolveChestsForScore,
  resolvePrepChests,
  prepTotal,
  aggregateTierSlice,
  defaultChestGrid,
} from '../src/core/scoring/chests';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

const MIGRATION_PATH = 'supabase/migrations/20260915100000_war_aggregate_day0.sql';
const migration = read(MIGRATION_PATH);

describe('war_aggregate_day0 migration — SQL surface', () => {
  it('widens event_daily_scores.day and event_chest_tiers.day to 0..6', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.event_daily_scores[\s\S]*?event_daily_scores_day_check CHECK \(day BETWEEN 0 AND 6\)/
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.event_chest_tiers[\s\S]*?event_chest_tiers_day_check CHECK \(day BETWEEN 0 AND 6\)/
    );
    // The historical 1..6 CHECKs are no longer (re)created by this migration.
    expect(migration).not.toMatch(/CHECK \(day BETWEEN 1 AND 6\)/);
  });

  it('gm_upsert_daily_scores accepts day 0..6 with the 9,999,999,999 bound', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.gm_upsert_daily_scores(');
    expect(migration).toContain('v_day BETWEEN 0 AND 6 AND v_score >= 0 AND v_score <= 9999999999');
  });

  it('converges every player to a single prep source (zero double-counting)', () => {
    expect(migration).toContain('AND day BETWEEN 1 AND 5');
    expect(migration).toContain('AND day = 0');
    expect(migration).toContain('pseudo = ANY(v_agg_pseudos)');
    expect(migration).toContain('v_agg_pseudos @> ARRAY[v_pseudo]');
    // Day 6 is never part of the convergence.
    expect(migration).toContain('v_day BETWEEN 1 AND 5');
  });

  it('derives the participant cache from day 0..5 and never the sum path', () => {
    expect(migration).toContain('SUM(CASE WHEN day IN (0, 1, 2, 3, 4, 5) THEN score ELSE 0 END)::bigint');
    expect(migration).toContain('SUM(CASE WHEN day = 6 THEN score ELSE 0 END)::bigint');
    expect(migration).toContain('score        = NULL,');
  });

  it('applies the day-0 tier slice with a deterministic day-1 fallback', () => {
    expect(migration).toContain("(t->>'day')::int = 0");
    expect(migration).toContain("(t->>'day')::int = 1");
  });

  it('gm_save_chest_tiers accepts the day-0 bucket', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.gm_save_chest_tiers(p_guild text, p_event_name text, p_tiers jsonb)'
    );
    expect(migration).toContain('IF v_day BETWEEN 0 AND 6');
    expect(migration).toContain('v_last_agg := v_min_score;');
  });

  it('ends with the pgrst reload notification', () => {
    expect(migration.trim().toLowerCase()).toMatch(/notify pgrst, 'reload schema';?\s*$/);
  });
});

describe('member-portal integrity guard', () => {
  // A player's own SvS/GvG submission used to be REJECTED on a war session
  // (granular_session_use_daily), so the Days 1-5 score could never be sent.
  // The invariant is unchanged -- the daily grid stays the single source of
  // truth, and score_prep is never written directly on a war session -- but
  // the scores now go THROUGH the grid instead of being refused.
  it('routes war-session scores through gm_upsert_daily_scores, never a direct score_prep write', () => {
    const portal = edgeSource('member-portal');
    expect(portal).toContain('.from("war_sessions")');
    expect(portal).toContain('admin.rpc("gm_upsert_daily_scores"');
    expect(portal).toContain('warSubmissionRows(member.pseudo, prep, pvp)');
    expect(portal).toMatch(/if \(isWarSession\) \{\s*delete rowUpdate\.score_prep;\s*delete rowUpdate\.score_pvp;/);
    expect(portal).not.toContain('"granular_session_use_daily"');
  });
});

const GRID_WITH_AGG = [
  { day: 0, tier: 1, min_score: 0, chests: 1 },
  { day: 0, tier: 2, min_score: 10000, chests: 2 },
  { day: 1, tier: 1, min_score: 0, chests: 1 },
  { day: 1, tier: 2, min_score: 1000, chests: 2 },
  { day: 1, tier: 3, min_score: 2500, chests: 3 },
  { day: 2, tier: 1, min_score: 0, chests: 1 },
  { day: 2, tier: 2, min_score: 500, chests: 3 },
  { day: 6, tier: 1, min_score: 0, chests: 1 },
  { day: 6, tier: 2, min_score: 10000, chests: 5 },
];

const GRID_WITHOUT_AGG = GRID_WITH_AGG.filter((t) => t.day !== 0);

describe('prepTotal — canonical preparation total', () => {
  it('prioritizes the real sum over Day 1..5 when any daily score exists', () => {
    expect(
      prepTotal([
        { day: 1, score: 1000 },
        { day: 2, score: 2000 },
        { day: 3, score: 500 },
        { day: 0, score: 50000 },
      ])
    ).toBe(3500);
  });

  it('falls back to the aggregate (day 0) total when no daily score exists', () => {
    expect(prepTotal([{ day: 0, score: 12345 }])).toBe(12345);
  });

  it('ignores Day 6 and non-prep days in the prep total', () => {
    expect(
      prepTotal([
        { day: 6, score: 999999999 },
        { day: 0, score: 42 },
      ])
    ).toBe(42);
  });

  it('resolves to 0 for empty, null, malformed or negative inputs', () => {
    expect(prepTotal(null)).toBe(0);
    expect(prepTotal(undefined)).toBe(0);
    expect(prepTotal([])).toBe(0);
    expect(prepTotal([{ day: 1, score: -100 }])).toBe(0);
    expect(prepTotal([{ day: 0, score: null }])).toBe(0);
  });
});

describe('aggregateTierSlice — day-0 bucket with day-1 fallback', () => {
  it('prefers an explicitly configured day-0 tier slice', () => {
    const slice = aggregateTierSlice(GRID_WITH_AGG);
    expect(slice.length).toBe(2);
    expect(slice.every((t) => t.day === 0)).toBe(true);
  });

  it('falls back to the day-1 slice when no day-0 tier exists', () => {
    const slice = aggregateTierSlice(GRID_WITHOUT_AGG);
    expect(slice.length).toBe(3);
    expect(slice.every((t) => t.day === 1)).toBe(true);
  });

  it('returns an empty slice for null or empty grids', () => {
    expect(aggregateTierSlice(null)).toEqual([]);
    expect(aggregateTierSlice([])).toEqual([]);
  });
});

describe('resolvePrepChests — canonical prep chest resolution', () => {
  it('prioritizes real days: sums per-day chests, ignores the aggregate score', () => {
    const chests = resolvePrepChests(GRID_WITH_AGG, { 1: 1000, 2: 500 }, 99999999);
    // day 1 -> tier2 (1000) = 2 ; day 2 -> tier2 (500) = 3 ; total 5.
    expect(chests).toBe(5);
  });

  it('falls back to the aggregate total scored against the day-0 bucket', () => {
    expect(resolvePrepChests(GRID_WITH_AGG, null, 15000)).toBe(2);
    expect(resolvePrepChests(GRID_WITH_AGG, {}, 5000)).toBe(1);
  });

  it('falls back to the day-1 tier slice when no day-0 bucket is configured', () => {
    // aggregate 1000 against the day-1 slice -> tier2 (1000) = 2.
    expect(resolvePrepChests(GRID_WITHOUT_AGG, null, 1000)).toBe(2);
    expect(resolvePrepChests(GRID_WITHOUT_AGG, null, 0)).toBe(1);
  });

  it('resolves to 0 for empty grids or null scores (SQL parity)', () => {
    expect(resolvePrepChests(null, { 1: 100 }, 0)).toBe(0);
    expect(resolvePrepChests([], { 1: 100 }, 0)).toBe(0);
    expect(resolvePrepChests(GRID_WITH_AGG, {}, null)).toBe(0);
    expect(resolvePrepChests(GRID_WITH_AGG, null, -10)).toBe(0);
  });

  it('treats string daily scores like the DB coercion path', () => {
    const chests = resolvePrepChests(GRID_WITH_AGG, { 1: '1000' }, 0);
    expect(chests).toBe(2);
  });
});

describe('defaultChestGrid & non-regression', () => {
  it('includes a default day-0 cumulative bucket plus the 6 daily day blocks with 9 tiers each (63 total)', () => {
    const grid = defaultChestGrid();
    expect(grid.filter((t) => t.day === WAR_AGGREGATE_DAY).length).toBe(9);
    for (let d = 1; d <= 6; d++) {
      expect(grid.filter((t) => t.day === d).length).toBe(9);
    }
    expect(grid.length).toBe(63);
  });

  it('keeps deterministic threshold behavior of resolveChestsForScore with SvS defaults', () => {
    const d1 = defaultChestGrid('SvS').filter((t) => t.day === 1);
    expect(resolveChestsForScore(d1, 0)).toBe(0);
    expect(resolveChestsForScore(d1, 37999)).toBe(0);
    expect(resolveChestsForScore(d1, 38000)).toBe(1);
    expect(resolveChestsForScore(d1, 153000)).toBe(2);
    expect(resolveChestsForScore(d1, 1150000)).toBe(9);
  });

  it('exports the canonical constants', () => {
    expect(WAR_AGGREGATE_DAY).toBe(0);
    expect([...PREP_DAYS]).toEqual([1, 2, 3, 4, 5]);
  });
});
