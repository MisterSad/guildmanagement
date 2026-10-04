/**
 * tests/stats_view.test.js
 *
 * Post-cutover golden suite for the strict-TS `StatsView`
 * (src/modules/stats/views/StatsView.ts), which now owns the stats feature
 * after the legacy root `stats.js` removal.
 *
 * The former Phase-1 suite compared live output against stats.js; with the
 * legacy file gone, this pins the exact same expected results as golden
 * values (captured from the pre-cutover parity run) plus the cutover guard
 * that StatsView exposes no new `GM_*` global on `window`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// StatsView imports ensureAuthSession directly (phase M4c): neutralise it at
// its source module.
vi.mock('../src/core/api/supabase', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ensureAuthSession: async () => null };
});
import { StatsView } from '../src/modules/stats/views/StatsView';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { cache } from '../src/core/cache/cache';
import { mockStatsMembers, mockStatsEvents } from './helpers/stats-aggregate.js';

// ── Supabase mock (same shape as tests/stats.test.js) ─────────────────────────
class MockBuilder {
  constructor(rows) {
    this.rows = rows || [];
    this.where = [];
    this.notWhere = [];
    this.inWhere = null;
  }
  select() {
    return this;
  }
  eq(field, value) {
    this.where.push([field, value]);
    return this;
  }
  neq(field, value) {
    this.notWhere.push([field, value]);
    return this;
  }
  in(field, values) {
    this.inWhere = [field, values];
    return this;
  }
  or() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  _apply() {
    let rows = this.rows;
    for (const [field, value] of this.where) rows = rows.filter((r) => r[field] === value);
    for (const [field, value] of this.notWhere) rows = rows.filter((r) => r[field] !== value);
    if (this.inWhere) {
      const [field, values] = this.inWhere;
      rows = rows.filter((r) => values.includes(r[field]));
    }
    return rows;
  }
  maybeSingle() {
    const rows = this._apply();
    return Promise.resolve({ data: rows[0] || null, error: null });
  }
  then(resolve, reject) {
    return Promise.resolve({ data: this._apply(), error: null }).then(resolve, reject);
  }
}

function makeDb(handlers) {
  return {
    rpc: (name, params) => {
      const h = handlers.rpc && handlers.rpc[name];
      return h ? Promise.resolve(h(params)) : Promise.resolve({ data: [], error: null });
    },
    from: (table) => {
      const h = handlers.from && handlers.from[table];
      return h ? h() : new MockBuilder([]);
    },
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  };
}

const W1 = '2026-07-27';
const W2 = '2026-08-03';
const G = 'ALPHA';

// GammaGhost is on the roster and has a PENDING participation row: pending is
// what keeps them out of the scoring, not absence from the roster. The fixture
// used to leave them off it, which event_participants' (guild, pseudo) foreign
// key into guild_members makes impossible -- verified against production, zero
// orphan pseudos. The old code rebuilt its member list by unioning participant
// pseudos onto the roster, so the illegal fixture still rendered three rows.
const MEMBERS = [
  { pseudo: 'AlphaPrime', uid: '111', guild: G },
  { pseudo: 'BetaKnight', uid: '222', guild: G },
  { pseudo: 'GammaGhost', uid: '333', guild: G },
];

const PARTS = [
  {
    pseudo: 'AlphaPrime',
    event_name: 'SvS',
    session_id: 's1',
    week_start: W1,
    participated: 1,
    score: 100,
    score_prep: 0,
    score_pvp: 0,
    is_pending: false,
    guild: G,
  },
  {
    pseudo: 'BetaKnight',
    event_name: 'SvS',
    session_id: 's1',
    week_start: W1,
    participated: 0,
    score: 0,
    score_prep: 0,
    score_pvp: 0,
    is_pending: false,
    guild: G,
  },
  {
    pseudo: 'AlphaPrime',
    event_name: 'SvS',
    session_id: 's2',
    week_start: W2,
    participated: 1,
    score: 200,
    score_prep: 0,
    score_pvp: 0,
    is_pending: false,
    guild: G,
  },
  {
    pseudo: 'BetaKnight',
    event_name: 'SvS',
    session_id: 's2',
    week_start: W2,
    participated: 1,
    score: 50,
    score_prep: 0,
    score_pvp: 0,
    is_pending: false,
    guild: G,
  },
  {
    pseudo: 'GammaGhost',
    event_name: 'SvS',
    session_id: 's2',
    week_start: W2,
    participated: 1,
    score: 999,
    score_prep: 0,
    score_pvp: 0,
    is_pending: true,
    guild: G,
  },
];

const GLORY = [
  { pseudo: 'AlphaPrime', event_name: 'Glory', week_start: W1, score: 1000, guild: G },
  { pseudo: 'BetaKnight', event_name: 'Glory', week_start: W1, score: 0, guild: G },
  { pseudo: 'AlphaPrime', event_name: 'Glory', week_start: W2, score: 1500, guild: G },
  { pseudo: 'BetaKnight', event_name: 'Glory', week_start: W2, score: 0, guild: G },
];

const SQUADS = [
  { pseudo: 'AlphaPrime', role: 'Infantry', week_start: W1, guild: G },
  { pseudo: 'BetaKnight', role: 'Infantry', week_start: W2, guild: G },
];

function buildDb() {
  return makeDb({
    rpc: {
      gm_stats_weeks: () => ({ data: { ok: true, weeks: [W2, W1] }, error: null }),
      gm_stats_data: () => ({
        data: { guild: G, members: MEMBERS, participants: PARTS, glory: GLORY, squads: SQUADS },
        error: null,
      }),
      gm_stats_members: mockStatsMembers({ rows: PARTS, glory: GLORY, members: MEMBERS }),
      gm_stats_events: mockStatsEvents({
        rows: PARTS.concat(GLORY),
        members: MEMBERS,
        squads: typeof SQUADS !== 'undefined' ? SQUADS : [],
      }),
    },
    from: {
      guild_members: () => new MockBuilder(MEMBERS),
      event_participants: () => new MockBuilder(PARTS.concat(GLORY)),
      shadowfront_squads: () => new MockBuilder(SQUADS),
    },
  });
}

function mountContainers() {
  document.body.innerHTML = '<div class="stats-controls"></div>' + '<div class="stats-leaderboard-area"></div>';
}

// Phase S3 columns: rank | member | by-event chips | attended | reliability.
// ("Trend" only appears when the RPC was asked for one, which the leaderboard
// does and these fixtures, having a single week, do not qualify for.)
function parseLeaderboard() {
  const area = document.querySelector('.stats-leaderboard-area');
  if (!area) return [];
  return [...area.querySelectorAll('tbody tr')].map((tr) => {
    const tds = tr.querySelectorAll('td');
    const cell = (label) => {
      const td = [...tds].find((n) => n.getAttribute('data-label') === label);
      return td ? td.textContent.trim() : '';
    };
    return {
      pseudo: tds[1].querySelector('.gm-member-pseudo')?.textContent.trim() ?? '',
      buckets: cell('By event'),
      attended: cell('Attended'),
      reliability: cell('Reliability'),
    };
  });
}

describe('StatsView golden results (post stats.js cutover)', () => {
  beforeEach(() => {
    mountContainers();
    setDbClient(buildDb());
    cache.invalidate();
  });

  afterEach(() => {
    resetSupabaseClient();
    document.body.innerHTML = '';
    localStorage.removeItem('gm_stats_mode');
  });

  it('does not expose any new GM_* global on window (cutover guard)', async () => {
    const baseline = Object.getOwnPropertyNames(window)
      .filter((k) => k.startsWith('GM_'))
      .sort();
    const view = new StatsView();
    await view.load();
    const after = Object.getOwnPropertyNames(window)
      .filter((k) => k.startsWith('GM_'))
      .sort();
    expect(after).toEqual(baseline);
    expect(after).not.toContain('GM_STATS');
  });

  it('reliability leaderboard: golden rows, with the breakdown beside the number', async () => {
    // Phase S3. The old board scored 65 points with no way to see where they
    // came from; this one shows the components. The fixture's only bucket is
    // SvS, so reliability is that bucket's rate -- the coefficient cancels.
    const view = new StatsView();
    await view.load();

    expect(parseLeaderboard()).toEqual([
      { pseudo: 'AlphaPrime', buckets: 'SvS 1/1', attended: '1/1', reliability: '100%' },
      { pseudo: 'BetaKnight', buckets: 'SvS 1/1', attended: '1/1', reliability: '100%' },
      { pseudo: 'GammaGhost', buckets: 'SvS 0/1', attended: '0/1', reliability: '0%' },
    ]);
  });

  it('there is one leaderboard metric, not two competing ones', async () => {
    // "Global Score (Composite)" and "Attendance Rate (%)" were two answers to
    // one question, offered in a dropdown, disagreeing about the same member.
    localStorage.setItem('gm_stats_mode', 'participation');
    const view = new StatsView();
    await view.load();

    expect(document.querySelector('.metric-select')).toBeNull();
    expect(parseLeaderboard()[0].reliability).toBe('100%');
  });

  it('per-event mode (SvS): pending scores no longer outrank approved ones', async () => {
    // GammaGhost's 999 is on a row with is_pending = true. The old per-event
    // path did not filter pending rows -- the global board did -- so an
    // unapproved score sat at the top of the Event Deep-Dive and nowhere else.
    // A fourth inconsistency between boards, removed with the row walk.
    const view = new StatsView();
    await view.loadSingleEvent('SvS', [W2, W1]);

    expect(view.getState().leaderboardData.map((r) => [r.pseudo, r.score])).toEqual([
      ['AlphaPrime', 300],
      ['BetaKnight', 50],
      ['GammaGhost', 0],
    ]);
  });

  it('glory event normalization: golden aggregation', async () => {
    const view = new StatsView();
    await view.loadSingleEvent('Glory', [W2, W1]);

    const byPseudo = Object.fromEntries(view.getState().leaderboardData.map((r) => [r.pseudo, r.score]));
    expect(byPseudo.AlphaPrime).toBe(2500);
    expect(byPseudo.BetaKnight).toBe(0);
  });
});
