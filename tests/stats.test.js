import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';
import '../stats.js';

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
const MEMBERS = [
    { pseudo: 'AlphaPrime', uid: '111', guild: G },
    { pseudo: 'BetaKnight', uid: '222', guild: G }
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
            list_event_weeks: () => ({ data: [{ week_start: W2 }, { week_start: W1 }], error: null })
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
    const rows = [...area.querySelectorAll('tbody tr')].map((tr) => {
        const tds = tr.querySelectorAll('td');
        return {
            pseudo: tds[1].querySelector('.gm-member-pseudo').textContent.trim(),
            events: tds[2].textContent.trim(),
            glory: tds[3].textContent.trim(),
            score: tds[4].textContent.trim()
        };
    });
    return rows;
}

beforeEach(() => {
    mountContainers();
    db = buildDb();
    window.GM.db = db;
    window.GM.ensureAuthSession = async () => null;
});

afterEach(() => {
    delete window.GM.db;
    window.GM.ensureAuthSession = undefined;
    document.body.innerHTML = '';
});

describe('GM_STATS global mode', () => {
    it('computes weighted scores with glory deltas and consistency bonus', async () => {
        await window.GM_STATS.load();

        const rows = parseLeaderboard();
        // GammaGhost appears in the member union (pending rows still join the
        // member list) but scores 0 and does not inflate event totals.
        expect(rows).toHaveLength(3);
        expect(rows[0].pseudo).toBe('AlphaPrime');
        expect(rows[0].score).toBe('130 pts');
        expect(rows[1].pseudo).toBe('BetaKnight');
        expect(rows[1].score).toBe('50 pts');

        // AlphaPrime: 2/2 events, glory delta 0 (first declaration never
        // counts: with only two Glory weeks there is no measurable delta).
        expect(rows[0].events).toBe('2/2');
        expect(rows[0].glory).toBe('—');

        // BetaKnight: 1/2 events, no glory
        expect(rows[1].events).toBe('1/2');
        expect(rows[1].glory).toBe('—');

        // Pending-only member gets 0
        const gamma = rows.find((r) => r.pseudo === 'GammaGhost');
        expect(gamma.score).toBe('0 pts');
    });

    it('renders week/period controls', async () => {
        await window.GM_STATS.load();
        const controls = document.querySelector('.stats-controls');
        expect(controls.querySelectorAll('.week-select option').length).toBe(2);
        expect(controls.querySelectorAll('.period-select option').length).toBe(4);
    });

    it('does not throw when db is missing', async () => {
        delete window.GM.db;
        await expect(window.GM_STATS.load()).resolves.toBeUndefined();
    });
});

describe('GM_STATS participation mode', () => {
    it('computes attendance rates as scores', async () => {
        await window.GM_STATS.load();
        // switch mode by clicking the participation tab
        const btn = document.querySelector('button[data-gm-mode="participation"]');
        btn.click();
        await new Promise((r) => setTimeout(r, 0));
        await window.GM_STATS.load();

        const rows = parseLeaderboard();
        const alpha = rows.find((r) => r.pseudo === 'AlphaPrime');
        const beta = rows.find((r) => r.pseudo === 'BetaKnight');
        expect(alpha.score).toBe('100 pts');
        expect(alpha.events).toBe('2/2');
        expect(beta.score).toBe('50 pts');
        expect(beta.events).toBe('1/2');
    });
});

describe('GM_STATS KPI tabs', () => {
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

    function buildKpiDb() {
        const base = buildDb();
        return makeDb({
            rpc: { list_event_weeks: () => ({ data: [{ week_start: W2 }, { week_start: W1 }], error: null }) },
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
        window.GM.ensureAuthSession = async () => null;
        // Deterministic week helpers: current week = W2, previous = W1
        window.GM.getWeekStart = () => W2;
        window.GM.getPrevWeekStart = () => W1;
    });

    afterEach(() => {
        delete window.GM.db;
        window.GM.ensureAuthSession = undefined;
        window.GM.getWeekStart = undefined;
        window.GM.getPrevWeekStart = undefined;
        document.body.innerHTML = '';
    });

    it('renders Guild Health with power tiles and tier bars', async () => {
        await window.GM_STATS.load();
        const btn = document.querySelector('button[data-gm-mode="kpi-health"]');
        btn.click();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const area = document.querySelector('.stats-leaderboard-area');
        const text = area.textContent;
        // Total power = 80M + 50M + 20M = 150M -> "150.0M" via formatBigNum
        expect(text).toContain('Total Power');
        expect(text).toContain('Roster summary');
        expect(text).toContain('Power distribution');
    });

    it('renders Engagement and flags inactive members', async () => {
        await window.GM_STATS.load();
        const btn = document.querySelector('button[data-gm-mode="kpi-engage"]');
        btn.click();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const area = document.querySelector('.stats-leaderboard-area');
        const text = area.textContent;
        expect(text).toContain('Members inactive for 2+ weeks');
        expect(text).toContain('Weekly participation rate');
        expect(text).toContain('Members engaged per event type');
        // ZombieZzz has no participation in the current or previous week.
        expect(text).toContain('ZombieZzz');
    });

    it('renders Roster and Operations without throwing', async () => {
        await window.GM_STATS.load();
        const rosterBtn = document.querySelector('button[data-gm-mode="kpi-roster"]');
        rosterBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(document.querySelector('.stats-leaderboard-area').textContent).toContain('Role structure');

        const opsBtn = document.querySelector('button[data-gm-mode="kpi-ops"]');
        opsBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(document.querySelector('.stats-leaderboard-area').textContent).toContain('Pending score approvals');
    });

    it('Engagement breaks down engagement by event type', async () => {
        await window.GM_STATS.load();
        const btn = document.querySelector('button[data-gm-mode="kpi-engage"]');
        btn.click();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        // AlphaPrime + BetaKnight participated in SvS over the 2 weeks.
        expect(text).toContain('SvS');
        expect(text).toContain('GvG');
        expect(text).toContain('Shadowfront');
        expect(text).toContain('Arms Race');
        expect(text).toContain('DTR');
    });

    it('Engagement renders cleanly with no participation data', async () => {
        const emptyDb = makeDb({
            rpc: { list_event_weeks: () => ({ data: [], error: null }) },
            from: {
                guild_members: () => new MockBuilder(MEMBERS_POWER),
                event_participants: () => new MockBuilder([]),
                shadowfront_squads: () => new MockBuilder([])
            }
        });
        window.GM.db = emptyDb;
        await window.GM_STATS.load();
        const btn = document.querySelector('button[data-gm-mode="kpi-engage"]');
        btn.click();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const text = document.querySelector('.stats-leaderboard-area').textContent;
        expect(text).toContain('Weekly participation rate');
        expect(text).toContain('Members inactive for 2+ weeks');
        expect(text).toContain('ZombieZzz'); // no data -> everyone is inactive
    });
});
