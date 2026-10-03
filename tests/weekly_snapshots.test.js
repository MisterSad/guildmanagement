/**
 * Phase S4b: the weekly guild snapshot, and the one property it exists for.
 *
 * Seven tables reference the roster with
 *   FOREIGN KEY (guild, pseudo) REFERENCES guild_members ON DELETE CASCADE
 * so removing a member erases their history and every historical guild
 * aggregate moves with it. `guild_weekly_snapshots` is guild-grain and carries
 * NO member key, which is the entire point: a kick must not rewrite the past.
 *
 * The risk is that a later edit "tidies" the schema by adding that key back,
 * or reaches for a member-grain table because it seems more useful. Both look
 * like improvements and both silently undo the fix, so they are asserted
 * against here and in the migration's own DO block.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

const migration = read('supabase/migrations/20260927114958_guild_weekly_snapshots.sql');
const sql = stripComments(migration);

describe('the snapshot cannot be erased by removing a member', () => {
  it('references guilds, never guild_members', () => {
    const create = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.guild_weekly_snapshots'),
                             sql.indexOf('COMMENT ON TABLE'));
    expect(create).toContain('REFERENCES public.guilds(id)');
    expect(create, 'a (guild, pseudo) key would reintroduce the cascade this table exists to survive')
      .not.toContain('guild_members');
  });

  it('asserts that absence at migration time, against the live catalog', () => {
    // A comment saying "do not add this key" is not a guard. The migration
    // fails its own replay if the key ever appears.
    expect(sql).toContain("confrelid = 'public.guild_members'::regclass");
    expect(migration).toContain('a kick would rewrite history again');
  });

  it('is keyed one row per guild per week', () => {
    expect(sql).toContain('PRIMARY KEY (guild, week_start)');
  });
});

describe('the job runs where it cannot photograph a half-rebuilt tenant', () => {
  it('runs on Monday at 03:20, after the 03:00 DEMO reset', () => {
    // gm_reset_demo_tenant_data runs at 03:00 and deletes every DEMO row. A
    // snapshot before it would freeze data that is about to disappear.
    expect(sql).toContain("cron.schedule('weekly-stats-snapshot', '20 3 * * 1'");
    expect(migration).toContain('rebuilt at 03:00');
  });

  it('unschedules before scheduling, so a replay does not double-register', () => {
    const at = sql.indexOf("cron.unschedule('weekly-stats-snapshot')");
    const sched = sql.indexOf("cron.schedule('weekly-stats-snapshot'");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(sched);
  });

  it('iterates the guilds table rather than a list', () => {
    // ADR-003 invariant #1: no hardcoded tenant list anywhere.
    expect(sql).toContain('FOR v_g IN SELECT id FROM public.guilds LOOP');
  });
});

describe('what is stored, and what is admitted', () => {
  it('stores counts, not a score', () => {
    // The per-tenant coefficients stay declared once, in TypeScript
    // (finding B1). Storing a weighted score here would put them in two
    // languages and let them drift where tsc cannot see it.
    const insert = sql.slice(sql.indexOf('INSERT INTO public.guild_weekly_snapshots'));
    for (const coeff of ['coeff_svs', 'coeff_gvg', 'coeff_shadowfront', 'coeff_dtr', 'coeff_armsrace']) {
      expect(insert, `${coeff} must not be read here`).not.toContain(coeff);
    }
    expect(sql).toContain("'opp', opp, 'attendances', attendances, 'members', members");
  });

  it('normalises week_start to the ISO Monday', () => {
    expect(sql).toContain("v_week := date_trunc('week', p_week_start)::date");
    expect(sql).toContain('extract(isodow from week_start) <> 1');
  });

  it('marks backfilled rows as backfilled, because they are not contemporaneous', () => {
    // A backfilled week is computed from TODAY's roster: anyone removed before
    // the backfill ran is already gone from event_participants. The table would
    // otherwise look like it proves something it cannot.
    expect(sql).toContain("'backfill'");
    expect(sql).toContain("CHECK (source IN ('cron', 'backfill', 'manual'))");
    expect(migration).toContain('reproduces the bias it exists to stop');
  });

  it('is deny-all: RLS forced, no policies, service_role only', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON TABLE public.guild_weekly_snapshots FROM PUBLIC, anon, authenticated');
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]{0,80}guild_weekly_snapshots/);
  });

  it('ends by reloading the PostgREST schema cache', () => {
    expect(migration.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});

describe('ADR-019 records the decision, not just the code', () => {
  const adr = read('docs/adr/ADR-019-weekly-guild-snapshots.md');

  it('explains why a member-grain snapshot was rejected', () => {
    // The next person will try to simplify this into one table.
    expect(adr).toContain('member-grain');
    expect(adr).toContain('gm_erase_player');
  });

  it('states the limit of the backfill rather than burying it', () => {
    expect(adr).toContain('is not clean');
  });

  it('says plainly that member churn is still not measurable', () => {
    expect(adr).toContain('still not measurable');
  });
});
