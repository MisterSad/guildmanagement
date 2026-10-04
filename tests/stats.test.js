import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// StatsView imports getWeekStart directly (phase M4c), so pinning "the current
// week" goes through a mock of its source module instead of window.GM.
const weekOverride = vi.hoisted(() => ({ current: null }));
vi.mock('../src/core/utils/date', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getWeekStart: (...args) => (weekOverride.current !== null ? weekOverride.current : actual.getWeekStart(...args))
    };
});
// StatsView imports ensureAuthSession directly (phase M4c): neutralise it at
// its source module rather than through window.GM.
vi.mock('../src/core/api/supabase', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, ensureAuthSession: async () => null };
});
import { statsView } from '../src/modules/stats/views/StatsView';
import { mockStatsMembers, mockStatsHealth, mockStatsEvents } from './helpers/stats-aggregate.js';

// Bridge the /src StatsView onto the legacy window.GM_STATS surface, exactly
// like src/main.ts does in production, so the historical suite keeps exercising
// the same public API after the stats.js cutover.
window.GM_STATS = {
    load: () => statsView.load(),
    loadSingleEvent: (eventName, weeks) => statsView.loadSingleEvent(eventName, weeks),
    renderLeaderboard: () => statsView.renderLeaderboard(),
    setView: (view, mode) => statsView.setView(view, mode),
    getState: () => statsView.getState()
};

// ── Mock Supabase query builder ───────────────────────────────────────────────
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
        for (const [field, value] of this.where) {
            rows = rows.filter((r) => r[field] === value);
        }
        for (const [field, value] of this.notWhere) {
            rows = rows.filter((r) => r[field] !== value);
        }
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

let db;
let calls;

function makeDb(handlers) {
    calls = { from: [], rpc: [] };
    return {
        rpc: (name, params) => {
            calls.rpc.push([name, params]);
            const h = handlers.rpc[name];
            return h ? Promise.resolve(h(params)) : Promise.resolve({ data: [], error: null });
        },
        from: (table) => {
            calls.from.push(table);
            const h = handlers.from[table];
            return h ? h() : new MockBuilder([]);
        },
        auth: { getSession: async () => ({ data: { session: null }, error: null }) }
    };
}

const W1 = '2026-07-27';
const W2 = '2026-08-03';

const G = 'ALPHA';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// GammaGhost is on the roster and carries a PENDING row below: pending is what
// keeps them out of the scoring, not absence from the roster. Leaving them off
// it modelled something event_participants' (guild, pseudo) foreign key into
// guild_members makes impossible -- verified against production, zero orphan
// pseudos in either event_participants or shadowfront_squads.
const MEMBERS = [
    { pseudo: 'AlphaPrime', uid: '111', guild: G },
    { pseudo: 'BetaKnight', uid: '222', guild: G },
    { pseudo: 'GammaGhost', uid: '333', guild: G }
];

const PARTS = [
    { pseudo: 'AlphaPrime', event_name: 'SvS', session_id: 's1', week_start: W1, participated: 1, score: 100, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
    { pseudo: 'BetaKnight', event_name: 'SvS', session_id: 's1', week_start: W1, participated: 0, score: 0, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
    { pseudo: 'AlphaPrime', event_name: 'SvS', session_id: 's2', week_start: W2, participated: 1, score: 200, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
    { pseudo: 'BetaKnight', event_name: 'SvS', session_id: 's2', week_start: W2, participated: 1, score: 50, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
    // pending rows must NOT count as event instances nor attendance
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
            gm_stats_weeks: () => ({ data: { ok: true, weeks: [W2, W1] }, error: null }),
            gm_stats_data: () => ({
                data: {
                    guild: G,
                    members: MEMBERS,
                    participants: PARTS,
                    glory: GLORY,
                    squads: SQUADS
                },
                error: null
            }),
            gm_stats_members: mockStatsMembers({ rows: PARTS, glory: GLORY, members: MEMBERS }),
            gm_stats_events: mockStatsEvents({ rows: PARTS.concat(GLORY), members: MEMBERS, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] })
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

// Phase S3 columns: rank | member | by-event chips | attended | reliability,
// with "Trend" between the last two only when a trend was computed. Read by
// data-label rather than by position, so adding a column does not silently
// shift every assertion by one.
/** Drives the real period control, the way a user does. */
async function selectPeriod(value) {
    const sel = document.querySelector('.period-select');
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
}

function parseLeaderboard() {
    const area = document.querySelector('.stats-leaderboard-area');
    const rows = [...area.querySelectorAll('tbody tr')].map((tr) => {
        const tds = tr.querySelectorAll('td');
        const cell = (label) => {
            const td = [...tds].find((n) => n.getAttribute('data-label') === label);
            return td ? td.textContent.trim() : '';
        };
        return {
            pseudo: tds[1].querySelector('.gm-member-pseudo').textContent.trim(),
            buckets: cell('By event'),
            attended: cell('Attended'),
            trend: cell('Trend'),
            score: cell('Reliability')
        };
    });
    return rows;
}

beforeEach(() => {
    mountContainers();
    db = buildDb();
    window.GM.db = db;
    // Each test expects GM_STATS.load() to actually re-fetch against its own
    // mock DB; the TTL freshness cache (gm-utils.js) is a same-session
    // optimization and must not carry over between tests.
    if (window.GM.cache) window.GM.cache.invalidate();
});

afterEach(() => {
    delete window.GM.db;
    document.body.innerHTML = '';
    localStorage.removeItem('gm_stats_mode');
});

describe('computeShadowfrontAttendanceRate (regression: rate exceeding 100%)', () => {
    it('matches the normal case where assigned squads cover every attended week', () => {
        expect(window.GM.computeShadowfrontAttendanceRate(4, 5)).toBeCloseTo(0.8);
        expect(window.GM.computeShadowfrontAttendanceRate(5, 5)).toBe(1);
        expect(window.GM.computeShadowfrontAttendanceRate(0, 5)).toBe(0);
    });

    it('caps at 100% instead of exceeding it when attendance history has more weeks than squad-assignment rows still on file', () => {
        // Real production case: a player attended 8 Shadowfront weeks but
        // shadowfront_squads only has 6 assignment rows left (2 older ones
        // were overwritten by a later session) — this used to render as
        // Math.round(8/6*100) = 133%.
        expect(window.GM.computeShadowfrontAttendanceRate(8, 6)).toBe(1);
        // Never exceed 1 (100%) regardless of how far apart the two counts are.
        expect(window.GM.computeShadowfrontAttendanceRate(8, 4)).toBe(1);
        expect(window.GM.computeShadowfrontAttendanceRate(20, 1)).toBe(1);
    });

    it('still reports 100% for a player with attendance but zero squad-assignment rows on file', () => {
        expect(window.GM.computeShadowfrontAttendanceRate(3, 0)).toBe(1);
    });

    it('returns 0 for a player with neither attendance nor assignments, without dividing by zero', () => {
        expect(window.GM.computeShadowfrontAttendanceRate(0, 0)).toBe(0);
        expect(window.GM.computeShadowfrontAttendanceRate(null, null)).toBe(0);
        expect(window.GM.computeShadowfrontAttendanceRate(undefined, undefined)).toBe(0);
    });
});

describe('GM_STATS global mode', () => {
    it('computes weighted scores with glory deltas and consistency bonus by default for 1w (current week)', async () => {
        await window.GM_STATS.load();

        const rows = parseLeaderboard();
        expect(rows).toHaveLength(3);
        expect(rows[0].pseudo).toBe('AlphaPrime');
        expect(rows[0].score).toBe('100%');
        expect(rows[1].pseudo).toBe('BetaKnight');
        expect(rows[1].score).toBe('100%');

        // The breakdown is the point: a rate the admin can defend, per bucket.
        expect(rows[0].buckets).toBe('SvS 1/1');
        expect(rows[0].attended).toBe('1/1');
        expect(rows[1].buckets).toBe('SvS 1/1');

        // The pending row still counts for nobody, and GammaGhost is measured
        // against the same single opportunity rather than vanishing.
        expect(rows[2].pseudo).toBe('GammaGhost');
        expect(rows[2].score).toBe('0%');
        expect(rows[2].buckets).toBe('SvS 0/1');

    });

    it('renders week/period controls with 5 timeframe options (1w, 2w, 4w, 8w, all)', async () => {
        await window.GM_STATS.load();
        const controls = document.querySelector('.stats-controls');
        expect(controls.querySelectorAll('.week-select option').length).toBe(2);
        const periodOpts = controls.querySelectorAll('.period-select option');
        expect(periodOpts.length).toBe(5);
        expect(periodOpts[0].value).toBe('1w');
        expect(periodOpts[1].value).toBe('2w');
        expect(periodOpts[2].value).toBe('4w');
        expect(periodOpts[3].value).toBe('8w');
        expect(periodOpts[4].value).toBe('all');
    });

    it('does not throw when db is missing', async () => {
        delete window.GM.db;
        await expect(window.GM_STATS.load()).resolves.toBeUndefined();
    });
});

describe('GM_STATS reliability across the whole window', () => {
    it('rates each member against what their guild actually ran', async () => {
        await window.GM_STATS.load();
        await window.GM_STATS.setView('leaderboard');
        await selectPeriod('all');

        const rows = parseLeaderboard();
        const alpha = rows.find((r) => r.pseudo === 'AlphaPrime');
        const beta = rows.find((r) => r.pseudo === 'BetaKnight');
        // Two SvS weeks; Alpha made both, Beta one. One bucket, so the
        // coefficient cancels and reliability is that bucket's rate.
        expect(alpha.score).toBe('100%');
        expect(alpha.attended).toBe('2/2');
        expect(beta.score).toBe('50%');
        expect(beta.attended).toBe('1/2');
    });

    it('excludes events planned for a future week from the denominator', async () => {
        // Current week = W2. Add a session planned for W3 (the next week): it
        // must NOT inflate the total event count, so rates stay unchanged.
        const W3 = '2026-08-10';
        const base = buildDb();
        const futureParts = PARTS.concat([
            { pseudo: 'AlphaPrime', event_name: 'SvS', session_id: 's3', week_start: W3, participated: 1, score: 999, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
            { pseudo: 'BetaKnight', event_name: 'SvS', session_id: 's3', week_start: W3, participated: 0, score: 0, score_prep: 0, score_pvp: 0, is_pending: false, guild: G }
        ]);
        window.GM.db = makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W3, W2, W1] }, error: null }),
                gm_stats_data: () => ({ data: { guild: G, members: MEMBERS, participants: futureParts, glory: GLORY, squads: SQUADS }, error: null }),
                gm_stats_members: mockStatsMembers({ rows: futureParts, glory: GLORY, members: MEMBERS }),
                gm_stats_events: mockStatsEvents({ rows: futureParts.concat(GLORY), members: MEMBERS, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS),
                event_participants: () => new MockBuilder(futureParts.concat(GLORY)),
                shadowfront_squads: () => new MockBuilder(SQUADS)
            }
        });
        weekOverride.current = W2;

        try {
            await window.GM_STATS.load();
            await window.GM_STATS.setView('leaderboard');
            await selectPeriod('all');

            const rows = parseLeaderboard();
            const alpha = rows.find((r) => r.pseudo === 'AlphaPrime');
            const beta = rows.find((r) => r.pseudo === 'BetaKnight');
            // Same 2 opportunities as without the future session: W3 is ignored.
            expect(alpha.attended).toBe('2/2');
            expect(beta.attended).toBe('1/2');
        } finally {
            // Restore the real implementation so every later test in this
            // file sees the true current week again.
            weekOverride.current = null;
        }
    });
});

describe('GM_STATS coefficient resolution (regression)', () => {
    // Real DB event_name values for DTR/Arms Race ('Defend Trade Route',
    // 'ARMS RACE STAGE A') never matched the old hardcoded COEFFS keys
    // ('DTR', 'Arms Race'), so both silently fell back to coefficient 1
    // regardless of what the guild configured in Guild Settings. Proven here
    // by confirming a guild-configured coeff_dtr value actually changes the
    // weighted score for a Defend Trade Route participation, using the real
    // DB event name throughout (not the short label the old bug's lookup
    // key coincidentally used).
    // DeltaRunner attends the DTR and misses the SvS. Two buckets is the
    // minimum for a coefficient to mean anything: with a single bucket it
    // appears on both sides of the weighted fraction and cancels out, which is
    // correct -- a coefficient expresses a TRADE-OFF between event types, not
    // an inflation of one.
    const DTR_MEMBERS = [{ pseudo: 'DeltaRunner', uid: '999', guild: G }];
    const DTR_PARTS = [
        { pseudo: 'DeltaRunner', event_name: 'Defend Trade Route', session_id: 'd1', week_start: W1, participated: 1, score: 0, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
        { pseudo: 'DeltaRunner', event_name: 'SvS', session_id: 's1', week_start: W1, participated: 0, score: 0, score_prep: 0, score_pvp: 0, is_pending: false, guild: G }
    ];

    function buildDtrDb(guildConfigRows) {
        return makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W1] }, error: null }),
                gm_stats_data: () => ({ data: { guild: G, members: DTR_MEMBERS, participants: DTR_PARTS, glory: [], squads: [] }, error: null }),
                gm_stats_members: mockStatsMembers({ rows: DTR_PARTS, glory: [], members: DTR_MEMBERS }),
                gm_stats_events: mockStatsEvents({ rows: DTR_PARTS.concat([]), members: DTR_MEMBERS, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] })
            },
            from: {
                guild_members: () => new MockBuilder(DTR_MEMBERS),
                event_participants: () => new MockBuilder(DTR_PARTS),
                shadowfront_squads: () => new MockBuilder([]),
                guild_config: () => new MockBuilder(guildConfigRows || [])
            }
        });
    }

    // Forces global (weighted-score) leaderboard mode. statsView is a module
    // singleton, so an earlier describe block leaves state.currentMode wherever
    // its last test put it. This used to be done by clicking a button rendered
    // invisibly for exactly this purpose; setView() is the same path the
    // visible tabs take.
    async function loadInGlobalMode() {
        await window.GM_STATS.load();
        await window.GM_STATS.setView('leaderboard', 'global');
    }

    it('applies the guild-configured coeff_dtr to a Defend Trade Route row instead of the pre-bug fallback of 1', async () => {
        // Defaults: DTR 2, SvS 5. Attending the DTR and missing the SvS gives
        // 2/(2+5) = 29%. Raising coeff_dtr to 50 makes the attended event the
        // one that matters: 50/(50+5) = 91%.
        window.GM.db = buildDtrDb([]); // no override: falls back to default coeff_dtr = '2'
        await loadInGlobalMode();
        const defaultScore = parseFloat(parseLeaderboard().find((r) => r.pseudo === 'DeltaRunner').score);
        expect(defaultScore).toBeCloseTo(28.6, 0);

        window.GM.db = buildDtrDb([{ key: 'coeff_dtr', guild: G, value: '50' }]);
        await loadInGlobalMode();
        const customScore = parseFloat(parseLeaderboard().find((r) => r.pseudo === 'DeltaRunner').score);
        expect(customScore).toBeCloseTo(90.9, 0);

        // The configured coefficient must actually change the score — under
        // the pre-fix bug it was silently ignored and both runs would match.
        expect(customScore).toBeGreaterThan(defaultScore);
    });
});

describe('GM_STATS cockpit', () => {
    // Members with real power for the health/reliability computations.
    const MEMBERS_POWER = [
        { pseudo: 'AlphaPrime', uid: '111', guild: G, overall_power: 80000000, role: 'R4', created_at: '2026-05-01T00:00:00Z' },
        { pseudo: 'BetaKnight', uid: '222', guild: G, overall_power: 50000000, role: 'R3', created_at: '2026-06-15T00:00:00Z' },
        { pseudo: 'GammaGhost', uid: '333', guild: G, overall_power: 20000000, role: 'R2', created_at: '2026-07-20T00:00:00Z' },
        { pseudo: 'ZombieZzz', uid: '444', guild: G, overall_power: 5000000, role: 'R1', created_at: '2026-07-20T00:00:00Z' }
    ];
    const PARTS_POWER = [
        { pseudo: 'AlphaPrime', event_name: 'SvS', session_id: 's1', week_start: W2, participated: 1, is_pending: false, guild: G },
        { pseudo: 'BetaKnight', event_name: 'SvS', session_id: 's1', week_start: W2, participated: 1, is_pending: false, guild: G },
        // GammaGhost participated in the previous week only (still recent)
        { pseudo: 'GammaGhost', event_name: 'SvS', session_id: 'sOld', week_start: W1, participated: 1, is_pending: false, guild: G }
        // ZombieZzz never participated -> inactive
    ];

    // war_sessions and player_metrics_history have no raw-row equivalent in
    // these fixtures, so the Health RPC is given them directly.
    const WAR_FIXTURE = [
        { event_name: 'GvG', sessions: 1, day_wins: 6, day_losses: 0,
          per_day: { 1: { won: 1, lost: 0 }, 2: { won: 1, lost: 0 }, 3: { won: 1, lost: 0 },
                     4: { won: 1, lost: 0 }, 5: { won: 1, lost: 0 }, 6: { won: 1, lost: 0 } } },
        { event_name: 'SvS', sessions: 1, day_wins: 1, day_losses: 5,
          per_day: { 1: { won: 0, lost: 1 }, 2: { won: 0, lost: 1 }, 3: { won: 0, lost: 1 },
                     4: { won: 0, lost: 1 }, 5: { won: 0, lost: 1 }, 6: { won: 1, lost: 0 } } }
    ];
    const POWER_FIXTURE = [
        { week_start: W1, players: 4, median: 35000000, avg: 38750000 },
        { week_start: W2, players: 4, median: 40000000, avg: 43750000 }
    ];

    function buildKpiDb() {
        const base = buildDb();
        return makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W2, W1] }, error: null }),
                gm_stats_members: mockStatsMembers({ rows: PARTS_POWER, glory: [], members: MEMBERS_POWER }),
                gm_stats_events: mockStatsEvents({ rows: PARTS_POWER.concat([]), members: MEMBERS_POWER, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] }),
                gm_stats_health: mockStatsHealth({ rows: PARTS_POWER, members: MEMBERS_POWER, war: WAR_FIXTURE, power: POWER_FIXTURE })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS_POWER),
                event_participants: () => new MockBuilder(PARTS_POWER),
                shadowfront_squads: () => new MockBuilder([]),
                shadowfront_signups: () => new MockBuilder([]),
                guild_transfers: () => new MockBuilder([]),
                event_status: () => new MockBuilder([])
            }
        });
    }

    beforeEach(() => {
        mountContainers();
        db = buildKpiDb();
        window.GM.db = db;
            // Deterministic week helpers: current week = W2, previous = W1
        weekOverride.current = W2;
        window.GM.getPrevWeekStart = () => W1;
    });

    afterEach(() => {
        delete window.GM.db;
            weekOverride.current = null;
        window.GM.getPrevWeekStart = undefined;
        document.body.innerHTML = '';
    });

    it('leads with the four numbers a guild leader acts on', async () => {
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('Roster');
        expect(text).toContain('Core members');
        expect(text).toContain('Dormant');
        expect(text).toContain('Median reliability');
        expect(text).toContain('Power tiers');
    });

    it('shows the war record, day by day', async () => {
        // war_sessions has been in the schema the whole time and the Stats page
        // never read it. Days 1-5 are preparation, day 6 is the battle: the
        // split is what tells an admin which half they are losing.
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('War record');
        expect(text).toContain('6W - 0L');   // GvG, every day
        expect(text).toContain('1W - 5L');   // SvS: loses prep, wins day 6
    });

    it('shows power progression as a median, with its sample size', async () => {
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('Power progression');
        expect(text).toContain('Median member power');
        // 35M -> 40M is +14.3%. A SUM would be the wrong statistic here: a
        // guild's first OCR week covers part of the roster, and CLAW went from
        // 11 players scanned to 114 in one week.
        expect(text).toContain('+14.3%');
        expect(text).toContain('players scanned');
    });

    it('says how complete the data is, since every other number depends on it', async () => {
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('How complete is this data?');
        expect(text).toContain('Weeks recorded');
        // The sparse metrics are named rather than silently averaged over a
        // tenth of the roster: tech/champion/crew/flagship/fleet are unset in
        // this fixture.
        expect(text).toContain('Tech');
    });

    it('segments the roster by engagement instead of listing "inactive"', async () => {
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('Engagement');
        expect(text).toContain('Members turning up each week');
        // ZombieZzz never participated, so the roster has at least one dormant.
        expect(text).toContain('Dormant');
    });

    it('Engagement ignores a session planned for a future week', async () => {
        const W3 = '2026-08-10';
        const parts = PARTS_POWER.concat([
            { pseudo: 'AlphaPrime', event_name: 'SvS', session_id: 'sFut', week_start: W3, participated: 1, is_pending: false, guild: G }
        ]);
        window.GM.db = makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W3, W2, W1] }, error: null }),
                gm_stats_members: mockStatsMembers({ rows: parts, glory: [], members: MEMBERS_POWER }),
                gm_stats_events: mockStatsEvents({ rows: parts.concat([]), members: MEMBERS_POWER, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] }),
                gm_stats_health: mockStatsHealth({ rows: parts, members: MEMBERS_POWER, currentWeek: W2 })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS_POWER),
                event_participants: () => new MockBuilder(parts),
                shadowfront_squads: () => new MockBuilder([]),
                shadowfront_signups: () => new MockBuilder([]),
                guild_transfers: () => new MockBuilder([]),
                event_status: () => new MockBuilder([])
            }
        });
        weekOverride.current = W2;

        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        // A week that has not started cannot have results, and must not become
        // the most recent week shown.
        expect(text).not.toContain('10/08/2026');
        expect(text).not.toContain('2026-08-10');

        weekOverride.current = null;
    });

    it('renders the roster breakdown without throwing', async () => {
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('Roles');
        expect(text).toContain('Power tiers');
        expect(text).toContain('Pending transfers');
    });

    it('Engagement renders cleanly with no participation data', async () => {
        const emptyDb = makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [] }, error: null }),
                gm_stats_members: mockStatsMembers({ rows: [], glory: [], members: MEMBERS_POWER }),
                gm_stats_health: mockStatsHealth({ rows: [], members: MEMBERS_POWER })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS_POWER),
                event_participants: () => new MockBuilder([]),
                shadowfront_squads: () => new MockBuilder([])
            }
        });
        window.GM.db = emptyDb;
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        // A guild with nothing recorded must say so, not render empty charts.
        expect(text).toContain('Engagement');
        expect(text).toContain('No weeks with data yet');
        expect(text).toContain('No war sessions recorded yet');
    });

    it('persists the selected stats mode and reloads into it', async () => {
        const db = makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W2] }, error: null }),
                gm_stats_members: mockStatsMembers({ rows: PARTS_POWER, glory: [], members: MEMBERS_POWER }),
                gm_stats_events: mockStatsEvents({ rows: PARTS_POWER.concat([]), members: MEMBERS_POWER, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] }),
                gm_stats_health: mockStatsHealth({ rows: PARTS_POWER, members: MEMBERS_POWER })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS_POWER),
                event_participants: () => new MockBuilder(PARTS_POWER),
                shadowfront_squads: () => new MockBuilder([])
            }
        });
        window.GM.db = db;
        await window.GM_STATS.load();
        // Switch to the cockpit, then reload: the view is restored.
        //
        // This used to assert the persisted value was 'kpi-engage', reached by
        // clicking an invisible button. There were four such kpi-* modes and
        // all four rendered the same cockpit, so the mode being persisted named
        // a screen that did not exist. What matters, and what is asserted now,
        // is that a reload comes back to the cockpit rather than dropping the
        // user on the leaderboard.
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));
        expect(localStorage.getItem('gm_stats_mode')).toBe('kpi-health');

        await window.GM_STATS.load();
        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('Members turning up each week');
    });

    it('KPI modes hide the period/week selectors (no fallback to global)', async () => {
        const db = makeDb({
            rpc: { gm_stats_weeks: () => ({ data: { ok: true, weeks: [W2] }, error: null }) },
            from: {
                guild_members: () => new MockBuilder(MEMBERS_POWER),
                event_participants: () => new MockBuilder(PARTS_POWER),
                shadowfront_squads: () => new MockBuilder([])
            }
        });
        window.GM.db = db;
        await window.GM_STATS.load();
        await window.GM_STATS.setView('cockpit');
        await new Promise((r) => setTimeout(r, 0));

        const controls = document.querySelector('.stats-controls');
        // The period/week selectors must be absent in KPI mode.
        expect(controls.querySelector('.period-select')).toBeNull();
        expect(controls.querySelector('.week-select')).toBeNull();
    });

    it('accurately groups Shadowfront squads into 1 weekly key and excludes Glory from attendance', () => {
        const allRecords = [
            { pseudo: 'Alice', eventName: 'Shadowfront', sessionId: 'SF1-20260814-1', weekStart: '2026-08-10', attended: true },
            { pseudo: 'Bob', eventName: 'Shadowfront', sessionId: 'SF2-20260814-1', weekStart: '2026-08-10', attended: true },
            { pseudo: 'Alice', eventName: 'SvS', sessionId: 'SVS-2026-W33', weekStart: '2026-08-10', attended: true },
            { pseudo: 'Alice', eventName: 'ARMS RACE STAGE A', sessionId: 'ARA-20260811-1', weekStart: '2026-08-10', attended: true },
            { pseudo: 'Alice', eventName: 'ARMS RACE STAGE B', sessionId: 'ARB-20260811-1', weekStart: '2026-08-10', attended: true },
            { pseudo: 'Alice', eventName: 'Defend Trade Route', sessionId: 'DTR-20260812-1', weekStart: '2026-08-10', attended: true },
            { pseudo: 'Alice', eventName: 'Glory', sessionId: 'GLORY-2026-W33', weekStart: '2026-08-10', attended: true }
        ];

        // Unique tenant keys expected (Glory excluded):
        // 1. Shadowfront|2026-08-10 (SF1 and SF2 merged into 1)
        // 2. SvS|2026-08-10
        // 3. Arms Race|ARA-20260811-1
        // 4. Arms Race|ARB-20260811-1
        // 5. DTR|DTR-20260812-1
        // Total = 5

        const tenantKeys = new Set();
        allRecords.forEach(r => {
            if ((r.eventName || '').toLowerCase() === 'glory') return;
            tenantKeys.add(window.GM.eventScoringKey(r.eventName, r.sessionId, r.weekStart));
        });
        expect(tenantKeys.size).toBe(5);

        // Alice attended SF1, SvS, ARA, ARB, DTR -> attended = 5 / 5 = 100%
        const aliceRecords = allRecords.filter(r => r.pseudo === 'Alice');
        const aliceKeys = new Set();
        aliceRecords.forEach(r => {
            if ((r.eventName || '').toLowerCase() === 'glory') return;
            if (r.attended) aliceKeys.add(window.GM.eventScoringKey(r.eventName, r.sessionId, r.weekStart));
        });
        expect(aliceKeys.size).toBe(5);
        expect(Math.round((aliceKeys.size / tenantKeys.size) * 100)).toBe(100);

        // Bob only attended SF2 -> attended = 1 / 5 = 20%
        const bobRecords = allRecords.filter(r => r.pseudo === 'Bob');
        const bobKeys = new Set();
        bobRecords.forEach(r => {
            if ((r.eventName || '').toLowerCase() === 'glory') return;
            if (r.attended) bobKeys.add(window.GM.eventScoringKey(r.eventName, r.sessionId, r.weekStart));
        });
        expect(bobKeys.size).toBe(1);
        expect(Math.round((bobKeys.size / tenantKeys.size) * 100)).toBe(20);
    });

    it('renders Shadowfront, Arms Race, and DTR event leaderboards', async () => {
        const EVENT_PARTS = PARTS.concat([
            { pseudo: 'AlphaPrime', event_name: 'Shadowfront', session_id: 'sf1', week_start: W2, participated: 1, score: 50, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
            { pseudo: 'AlphaPrime', event_name: 'Arms Race', session_id: 'ar1', week_start: W2, participated: 1, score: 40, score_prep: 0, score_pvp: 0, is_pending: false, guild: G },
            { pseudo: 'AlphaPrime', event_name: 'Defend Trade Route', session_id: 'd1', week_start: W2, participated: 1, score: 30, score_prep: 0, score_pvp: 0, is_pending: false, guild: G }
        ]);
        window.GM.db = makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W2, W1] }, error: null }),
                gm_stats_data: () => ({
                    data: {
                        guild: G,
                        members: MEMBERS,
                        participants: EVENT_PARTS,
                        glory: GLORY,
                        squads: SQUADS
                    },
                    error: null
                }),
                gm_stats_members: mockStatsMembers({ rows: EVENT_PARTS, glory: GLORY, members: MEMBERS }),
                gm_stats_events: mockStatsEvents({ rows: EVENT_PARTS.concat(GLORY), members: MEMBERS, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS),
                event_participants: () => new MockBuilder(EVENT_PARTS.concat(GLORY)),
                shadowfront_squads: () => new MockBuilder(SQUADS)
            }
        });
        await window.GM_STATS.load();

        await window.GM_STATS.setView('events', 'Shadowfront');
        expect(document.querySelector('.stats-leaderboard-area').textContent).toContain('AlphaPrime');

        await window.GM_STATS.setView('events', 'Arms Race');
        expect(document.querySelector('.stats-leaderboard-area').textContent).toContain('AlphaPrime');

        await window.GM_STATS.setView('events', 'DTR');
        expect(document.querySelector('.stats-leaderboard-area').textContent).toContain('AlphaPrime');
    });
});

