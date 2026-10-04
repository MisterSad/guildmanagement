/**
 * tests/score_limit.test.js
 *
 * Static guard for the "maximum Glory/SvS/GvG score tracking" limit raising
 * (500,000,000 -> 9,999,999,999):
 *   - the shared Edge constant is the single source of truth;
 *   - the SQL migration widens every INT4 score column to BIGINT (INT4 would
 *     cap at ~2.147B, below the new 9.99B bound);
 *   - the daily-grid RPC and the glory RPC acknowledge the new bound;
 *   - no stale 500M bound survives anywhere under supabase/functions or src.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

const MIGRATION_PATH = 'supabase/migrations/20260914100000_raise_event_score_limit_to_9999999999.sql';
const migration = read(MIGRATION_PATH);
const shared = read('supabase/functions/_shared/player-actions.ts');
const warMigration = read('supabase/migrations/20260914090000_war_daily_scores_and_chest_tiers.sql');

describe('Score limit raising (500M -> 9,999,999,999)', () => {
  it('defines the raised constant as the single source of truth', () => {
    expect(shared).toContain('export const MAX_ALLOWED_EVENT_SCORE = 9_999_999_999;');
  });

  it('widens event_participants score columns to BIGINT', () => {
    const stmt = 'ALTER TABLE public.event_participants';
    const at = migration.indexOf(stmt);
    expect(at).toBeGreaterThan(-1);
    const block = migration.slice(at, at + 240);
    expect(block).toContain('ALTER COLUMN score      TYPE BIGINT');
    expect(block).toContain('ALTER COLUMN score_prep TYPE BIGINT');
    expect(block).toContain('ALTER COLUMN score_pvp  TYPE BIGINT');
  });

  it('widens event_daily_scores.score and weekly_scores.glory_score to BIGINT', () => {
    expect(migration).toContain('ALTER TABLE public.event_daily_scores');
    expect(migration).toContain('ALTER COLUMN score TYPE BIGINT');
    expect(migration).toContain('ALTER TABLE public.weekly_scores');
    expect(migration).toContain('ALTER COLUMN glory_score TYPE BIGINT');
  });

  it('raises the daily grid RPC bound to 9,999,999,999 with BIGINT-safe sums', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.gm_upsert_daily_scores(');
    expect(migration).toContain('v_score >= 0 AND v_score <= 9999999999');
    // The derived D1-5 / D6 sums must no longer be squashed through INT4.
    expect(migration).toContain('SUM(CASE WHEN day <= 5 THEN score ELSE 0 END)::bigint');
    expect(migration).toContain('SUM(CASE WHEN day = 6 THEN score ELSE 0 END)::bigint');
  });

  it('raises the glory RPC to a BIGINT parameter with the new cap', () => {
    expect(migration).toContain('p_glory bigint');
    expect(migration).toContain('LEAST(9999999999, COALESCE(p_glory, 0))');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.gm_upsert_player_glory(text, text, date, integer);');
    // No ::integer write-path cast that would overflow on >2.147B glory.
    expect(migration).not.toMatch(/v_safe_glory::integer/);
  });

  it('leaves no stale 500M bound in edge functions or src', () => {
    for (const scanDir of ['supabase/functions', 'src']) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(path.resolve(root, dir), { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(ts|tsx|js)$/.test(entry.name)) {
            const content = read(full);
            expect(content, `stale 500M bound in ${full}`).not.toMatch(/500_000_000|500000000/);
          }
        }
      };
      walk(scanDir);
    }
  });

  it('the war migration daily grid bound is superseded by the new migration', () => {
    expect(warMigration).toContain('v_score <= 500000000');
    expect(migration.indexOf('v_score <= 9999999999')).toBeGreaterThan(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.gm_upsert_daily_scores(')
    );
  });
});
