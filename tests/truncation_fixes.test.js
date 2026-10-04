// Short-term plan, phase 1: reads that crossed PostgREST's silent 1,000-row cap
// (audit PERF-02 to PERF-05) and tables that only ever grew (PERF-09, DB-16).
//
// Measured on production before applying, in a rolled-back transaction: for the
// busiest guild (9,859 participation rows) the new aggregate covered all 92 of a
// player's sessions with 0 mismatches against a full SQL computation; the Glory
// read returned 147 rows for 147 players of a guild with 1,105 history rows.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

let likeCalls = [];
let response = { data: [], error: null };
const mockSupabase = {
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      like: (col, pattern) => {
        likeCalls.push([col, pattern]);
        return Promise.resolve(response);
      },
    };
    return q;
  },
};
vi.mock('../src/core/api/supabase', () => ({ getSupabaseClient: () => mockSupabase }));

const { fetchAllRows } = await import('../src/core/api/paginate.ts');
const { sessionIdBase, buildEventSessionId } = await import('../src/core/config/events.ts');
const { EventsService } = await import('../src/modules/events/events.service.ts');

describe('fetchAllRows reads past the 1,000-row cap', () => {
  const source = Array.from({ length: 2500 }, (_, i) => ({ id: i }));

  it('pages until an empty page and returns every row', async () => {
    const calls = [];
    const res = await fetchAllRows((from, to) => {
      calls.push([from, to]);
      return Promise.resolve({ data: source.slice(from, Math.min(to + 1, from + 1000)), error: null });
    });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2500);
    expect(calls[0]).toEqual([0, 999]);
  });

  it('is not fooled by a server cap smaller than the page size', async () => {
    const res = await fetchAllRows((from) => Promise.resolve({ data: source.slice(from, from + 300), error: null }));
    expect(res.data).toHaveLength(2500);
  });

  it('returns the first error instead of a silently partial list', async () => {
    let n = 0;
    const res = await fetchAllRows((from) => {
      n++;
      return Promise.resolve(
        n === 2 ? { data: null, error: new Error('boom') } : { data: source.slice(from, from + 1000), error: null }
      );
    });
    expect(res.error).toBeInstanceOf(Error);
  });
});

describe("session ids: only today's are read", () => {
  const day = new Date('2026-10-03T12:00:00Z');

  it('sessionIdBase gives the daily prefix, and nothing for weekly or ad-hoc events', () => {
    expect(sessionIdBase('Arms Race Stage A', day)).toBe('ARA-20261003');
    expect(sessionIdBase('Defend Trade Route', day)).toBe('DTR-20261003');
    expect(sessionIdBase('Shadowfront Squad 2', day)).toBe('SF2-20261003');
    expect(sessionIdBase('SvS', day)).toBeNull();
    expect(sessionIdBase('Something else', day)).toBeNull();
  });

  it('buildEventSessionId still picks the first free suffix', () => {
    expect(buildEventSessionId('Arms Race Stage A', day, ['ARA-20261003-1', 'ARA-20261003-2'])).toBe('ARA-20261003-3');
    expect(buildEventSessionId('SvS', day)).toMatch(/^SVS-/);
  });

  beforeEach(() => {
    likeCalls = [];
    response = { data: [], error: null };
  });

  it('takenSessionIdsToday filters by prefix server-side and de-duplicates', async () => {
    response = {
      data: [{ session_id: 'ARA-20261003-1' }, { session_id: 'ARA-20261003-1' }, { session_id: 'ARA-20261003-2' }],
      error: null,
    };
    const res = await EventsService.takenSessionIdsToday('DEMO', 'Arms Race Stage A', 'Arms Race Stage A', day);
    expect(likeCalls).toEqual([['session_id', 'ARA-20261003-%']]);
    expect(res).toEqual({ ok: true, ids: ['ARA-20261003-1', 'ARA-20261003-2'] });
  });

  it('reports a failed read instead of returning an empty list', async () => {
    response = { data: null, error: { message: 'boom' } };
    const res = await EventsService.takenSessionIdsToday('DEMO', 'Defend Trade Route', 'Defend Trade Route', day);
    expect(res.ok).toBe(false);
  });

  it("the three views refuse to start a session when today's ids are unknown", () => {
    for (const f of [
      'src/modules/armsrace/views/ArmsRaceView.ts',
      'src/modules/events/views/EventsView.ts',
      'src/modules/shadowfront/views/ShadowfrontView.ts',
    ]) {
      const src = read(f);
      expect(src, f).toContain('EventsService.takenSessionIdsToday(');
      expect(src, f).toMatch(/if \(!taken\.ok\) \{[\s\S]{0,200}return;/);
      expect(src, f).not.toMatch(/select\('session_id'\)\s*\.eq\('guild'/);
    }
  });
});

describe('whole-history reads', () => {
  it('no .limit(100000) pretends to lift the cap anywhere in src/', () => {
    const walk = (d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(path.join(root, 'src')).filter((f) => /\.(ts|js)$/.test(f))) {
      expect(fs.readFileSync(f, 'utf-8'), f).not.toMatch(/\.limit\(\s*\d{5,}\s*\)/);
    }
  });

  it('Shadowfront pages its history and refuses a partial load', () => {
    const src = read('src/modules/shadowfront/views/ShadowfrontView.ts');
    expect(src.match(/fetchAllRows\(/g)).toHaveLength(2);
    expect(src).toContain('if (loadError) throw loadError;');
  });

  it('member-portal aggregates guild session stats in SQL', () => {
    const _src = edgeSource('member-portal');
    const block = edgeFunctionBody('member-portal', 'getHistory');
    expect(block).toContain(
      'admin.rpc("gm_player_session_guild_stats", { p_guild: member.guild, p_pseudo: member.pseudo })'
    );
    expect(block).not.toContain('allGuildParticipants');
    expect(block).toContain('if (sessionStatsRes.error)');
  });

  it('the roster reads one Glory score per player', () => {
    const src = read('src/modules/app/members/members.controller.ts');
    expect(src).toContain('fetchLatestGloryScores(client, currentG)');
    expect(read('src/modules/members/members.service.ts')).toContain(
      "db.rpc('gm_latest_glory_scores', { p_guild: guild })"
    );
    expect(src).not.toMatch(/eq\('event_name', 'Glory'\)\.not\('score'/);
  });
});

describe('the migration', () => {
  const sql = read('supabase/migrations/20261003112152_truncation_fixes_and_log_retention.sql');
  const fn = (name) =>
    sql.slice(sql.indexOf(`FUNCTION public.${name}(`), sql.indexOf('$$;', sql.indexOf(`FUNCTION public.${name}(`)));

  it("the two read RPCs run with the caller's rights", () => {
    expect(fn('gm_player_session_guild_stats')).not.toContain('SECURITY DEFINER');
    expect(fn('gm_latest_glory_scores')).not.toContain('SECURITY DEFINER');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.gm_player_session_guild_stats\(text, text\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.gm_latest_glory_scores\(text\) TO authenticated, service_role;/
    );
  });

  it('counts a row the way the TypeScript it replaces did', () => {
    expect(fn('gm_player_session_guild_stats')).toMatch(
      /> 0\s+OR COALESCE\(ep\.participated, 0\) > 0\s+OR COALESCE\(ep\.sub_present, false\)/
    );
  });

  it('purges the ephemeral auth tables and two-week-old cron history', () => {
    expect(fn('gm_purge_discord_ephemera')).toContain(
      'DELETE FROM public.webauthn_challenges WHERE expires_at <= now();'
    );
    expect(fn('gm_purge_discord_ephemera')).toContain(
      "DELETE FROM public.discord_verification_throttle WHERE window_start < now() - interval '24 hours';"
    );
    expect(fn('gm_purge_cron_history')).toContain(
      "DELETE FROM cron.job_run_details WHERE end_time < now() - interval '14 days';"
    );
    expect(sql).toContain(
      "cron.schedule('daily-cron-history-purge', '50 4 * * *', 'SELECT public.gm_purge_cron_history();')"
    );
  });
});
