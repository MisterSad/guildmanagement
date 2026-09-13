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
 * that StatsView exposes no new `window.GM_*` global.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StatsView } from '../src/modules/stats/views/StatsView';

// ── Supabase mock (same shape as tests/stats.test.js) ─────────────────────────
class MockBuilder {
  constructor(rows) {
    this.rows = rows || [];
    this.where = [];
    this.notWhere = [];
    this.inWhere = null;
  }
  select() { return this; }
  eq(field, value) { this.where.push([field, value]); return this; }
  neq(field, value) { this.notWhere.push([field, value]); return this; }
  in(field, values) { this.inWhere = [field, values]; return this; }
  or() { return this; }
  order() { return this; }
  limit() { return this; }
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
    auth: { getSession: async () => ({ data: { session: null }, error: null }) }
  };
}

const W1 = '2026-07-27';
const W2 = '2026-08-03';
const G = 'ALPHA';

const MEMBERS = [
  { pseudo: 'AlphaPrime', uid: '111', guild: G },
  { pseudo: 'BetaKnight', uid: '222', guild: G }
];

const PARTS = [
  { pseudo: 'AlphaPrime', event_name: 'SvS', session_id: 's1', week_start: W1, participated: 1, score: 100, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
  { pseudo: 'BetaKnight', event_name: 'SvS', session_id: 's1', week_start: W1, participated: 0, score: 0, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
  { pseudo: 'AlphaPrime', event_name: 'SvS', session_id: 's2', week_start: W2, participated: 1, score: 200, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
  { pseudo: 'BetaKnight', event_name: 'SvS', session_id: 's2', week_start: W2, participated: 1, score: 50, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
  { pseudo: 'GammaGhost', event_name: 'SvS', session_id: 's2', week_start: W2, participated: 1, score: 999, score_prep: 0, score_pvp: 0, is_pending: true, guild: G }
];

const GLORY = [
  { pseudo: 'AlphaPrime', event_name: 'Glory', week_start: W1, score: 1000, guild: G },
  { pseudo: 'BetaKnight', event_name: 'Glory', week_start: W1, score: 0, guild: G },
  { pseudo: 'AlphaPrime', event_name: 'Glory', week_start: W2, score: 1500, guild: G },
  { pseudo: 'BetaKnight', event_name: 'Glory', week_start: W2, score: 0, guild: G }
];

const SQUADS = [
  { pseudo: 'AlphaPrime', role: 'Infantry', week_start: W1, guild: G },
  { pseudo: 'BetaKnight', role: 'Infantry', week_start: W2, guild: G }
];

function buildDb() {
  return makeDb({
    rpc: {
      list_event_weeks: () => ({ data: [{ week_start: W2 }, { week_start: W1 }], error: null }),
      gm_stats_data: () => ({
        data: { guild: G, members: MEMBERS, participants: PARTS, glory: GLORY, squads: SQUADS },
        error: null
      })
    },
    from: {
      guild_members: () => new MockBuilder(MEMBERS),
      event_participants: () => new MockBuilder(PARTS.concat(GLORY)),
      shadowfront_squads: () => new MockBuilder(SQUADS)
    }
  });
}

function mountContainers() {
  document.body.innerHTML =
    '<div class="stats-controls"></div>' +
    '<div class="stats-leaderboard-area"></div>';
}

function parseLeaderboard() {
  const area = document.querySelector('.stats-leaderboard-area');
  if (!area) return [];
  return [...area.querySelectorAll('tbody tr')].map((tr) => {
    const tds = tr.querySelectorAll('td');
    const hasGlory = tds.length > 4;
    return {
      pseudo: tds[1].querySelector('.gm-member-pseudo')?.textContent.trim() ?? '',
      events: tds[2].textContent.trim(),
      glory: hasGlory ? tds[3].textContent.trim() : '-',
      score: (hasGlory ? tds[4] : tds[3]).textContent.trim()
    };
  });
}

describe('StatsView golden results (post stats.js cutover)', () => {
  beforeEach(() => {
    mountContainers();
    window.GM.db = buildDb();
    window.GM.ensureAuthSession = async () => null;
    if (window.GM.cache) window.GM.cache.invalidate();
  });

  afterEach(() => {
    delete window.GM.db;
    window.GM.ensureAuthSession = undefined;
    document.body.innerHTML = '';
    localStorage.removeItem('gm_stats_mode');
  });

  it('does not expose any new window.GM_* global (cutover guard)', async () => {
    const baseline = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();
    const view = new StatsView();
    await view.load();
    const after = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();
    expect(after).toEqual(baseline);
    expect(window.GM_STATS).toBeUndefined();
  });

  it('global weighted mode: golden leaderboard rows and max possible', async () => {
    const view = new StatsView();
    await view.load();

    expect(view.getState().lastMaxPossible).toBe(225);
    expect(parseLeaderboard()).toEqual([
      { pseudo: 'AlphaPrime', events: '1/1', glory: '-', score: '65 pts' },
      { pseudo: 'BetaKnight', events: '1/1', glory: '-', score: '65 pts' },
      { pseudo: 'GammaGhost', events: '0/1', glory: '-', score: '0 pts' }
    ]);
  });

  it('attendance-rate mode: golden leaderboard rows', async () => {
    localStorage.setItem('gm_stats_mode', 'participation');
    const view = new StatsView();
    await view.load();

    expect(parseLeaderboard()).toEqual([
      { pseudo: 'AlphaPrime', events: '2/2', glory: '-', score: '100 pts' },
      { pseudo: 'BetaKnight', events: '1/2', glory: '-', score: '50 pts' },
      { pseudo: 'GammaGhost', events: '0/2', glory: '-', score: '0 pts' }
    ]);
  });

  it('per-event mode (SvS) via loadSingleEvent: golden aggregation', async () => {
    const view = new StatsView();
    await view.loadSingleEvent('SvS', [W2, W1]);

    expect(view.getState().leaderboardData.map((r) => [r.pseudo, r.score])).toEqual([
      ['GammaGhost', 999],
      ['AlphaPrime', 300],
      ['BetaKnight', 50]
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
