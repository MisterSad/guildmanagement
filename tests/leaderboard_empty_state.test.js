import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { statsView } from '../src/modules/stats/views/StatsView';
import { mockStatsMembers, mockStatsEvents } from './helpers/stats-aggregate.js';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { cache } from '../src/core/cache/cache';

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

const G = 'ALPHA';
const W_EMPTY = '2026-08-10';
const W_SCORED = '2026-08-17';

const MEMBERS = [
    { pseudo: 'Alice', uid: '101', guild: G },
    { pseudo: 'Bob', uid: '102', guild: G },
    { pseudo: 'Charlie', uid: '103', guild: G }
];

describe('Ticket 1.2 — Leaderboard & Stats Empty State', () => {
    beforeEach(() => {
        document.body.innerHTML =
            '<div class="stats-controls"></div>' +
            '<div class="stats-leaderboard-area"></div>';
        cache.invalidate();
    });

    afterEach(() => {
        resetSupabaseClient();
        document.body.innerHTML = '';
        localStorage.removeItem('gm_stats_mode');
    });

    it('masks podium and renders empty state when participant list is empty for an event', async () => {
        // DB with members but 0 event participants in W_EMPTY
        setDbClient(makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W_EMPTY] }, error: null }),
                gm_stats_data: () => ({
                    data: {
                        guild: G,
                        members: MEMBERS,
                        participants: [],
                        glory: [],
                        squads: []
                    },
                    error: null
                })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS),
                event_participants: () => new MockBuilder([])
            }
        }));

        // Load single event mode for SvS on the empty week
        await statsView.loadSingleEvent('SvS', [W_EMPTY]);

        const area = document.querySelector('.stats-leaderboard-area');
        expect(area).not.toBeNull();

        // 1. Fake podium MUST NOT be rendered
        const podium = area.querySelector('.gm-podium-stage-container');
        expect(podium).toBeNull();

        // 2. Regular table MUST NOT be rendered
        const table = area.querySelector('table');
        expect(table).toBeNull();

        // 3. Harmonized Empty State MUST be rendered
        const emptyState = area.querySelector('.gm-empty');
        expect(emptyState).not.toBeNull();
        expect(emptyState.classList.contains('gm-leaderboard-empty')).toBe(true);

        const title = emptyState.querySelector('.gm-empty-title');
        expect(title).not.toBeNull();
        expect(title.textContent).toBe('No event data for this period');

        const desc = emptyState.querySelector('.gm-empty-hint');
        expect(desc).not.toBeNull();
        expect(desc.textContent).toBe('No scores recorded for this event in the selected week. Try selecting another week or trigger an OCR scan.');

        const trophyIcon = emptyState.querySelector('.ph-trophy');
        expect(trophyIcon).not.toBeNull();
    });

    it('masks podium and renders empty state when participants exist but all scores are zero', async () => {
        const zeroParts = [
            { pseudo: 'Alice', event_name: 'Arms Race', week_start: W_EMPTY, score: 0, score_prep: 0, score_pvp: 0, participated: 0, guild: G },
            { pseudo: 'Bob', event_name: 'Arms Race', week_start: W_EMPTY, score: 0, score_prep: 0, score_pvp: 0, participated: 0, guild: G },
            { pseudo: 'Charlie', event_name: 'Arms Race', week_start: W_EMPTY, score: 0, score_prep: 0, score_pvp: 0, participated: 0, guild: G }
        ];

        setDbClient(makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W_EMPTY] }, error: null }),
                gm_stats_data: () => ({
                    data: {
                        guild: G,
                        members: MEMBERS,
                        participants: zeroParts,
                        glory: [],
                        squads: []
                    },
                    error: null
                }),
                gm_stats_members: mockStatsMembers({ rows: zeroParts, glory: [], members: MEMBERS }),
                gm_stats_events: mockStatsEvents({ rows: zeroParts.concat([]), members: MEMBERS, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS),
                event_participants: () => new MockBuilder(zeroParts)
            }
        }));

        await statsView.loadSingleEvent('Arms Race', [W_EMPTY]);

        const area = document.querySelector('.stats-leaderboard-area');
        // Podium and table MUST NOT be displayed
        expect(area.querySelector('.gm-podium-stage-container')).toBeNull();
        expect(area.querySelector('table')).toBeNull();

        // Empty state is rendered
        const emptyState = area.querySelector('.gm-empty');
        expect(emptyState).not.toBeNull();
        expect(emptyState.querySelector('.gm-empty-title').textContent).toBe('No event data for this period');
    });

    it('renders normal podium and table as soon as at least one valid score > 0 is present', async () => {
        const validParts = [
            { pseudo: 'Alice', event_name: 'SvS', week_start: W_SCORED, score: 350, score_prep: 200, score_pvp: 150, participated: 1, guild: G },
            { pseudo: 'Bob', event_name: 'SvS', week_start: W_SCORED, score: 100, score_prep: 50, score_pvp: 50, participated: 1, guild: G },
            { pseudo: 'Charlie', event_name: 'SvS', week_start: W_SCORED, score: 0, score_prep: 0, score_pvp: 0, participated: 0, guild: G }
        ];

        setDbClient(makeDb({
            rpc: {
                gm_stats_weeks: () => ({ data: { ok: true, weeks: [W_SCORED] }, error: null }),
                gm_stats_data: () => ({
                    data: {
                        guild: G,
                        members: MEMBERS,
                        participants: validParts,
                        glory: [],
                        squads: []
                    },
                    error: null
                }),
                gm_stats_members: mockStatsMembers({ rows: validParts, glory: [], members: MEMBERS }),
                gm_stats_events: mockStatsEvents({ rows: validParts.concat([]), members: MEMBERS, squads: typeof SQUADS !== 'undefined' ? SQUADS : [] })
            },
            from: {
                guild_members: () => new MockBuilder(MEMBERS),
                event_participants: () => new MockBuilder(validParts)
            }
        }));

        await statsView.loadSingleEvent('SvS', [W_SCORED]);

        const area = document.querySelector('.stats-leaderboard-area');
        // Empty state must NOT be rendered
        expect(area.querySelector('.gm-leaderboard-empty')).toBeNull();

        // Normal podium MUST be rendered (since 3 members and top1 score > 0)
        const podium = area.querySelector('.gm-podium-stage-container');
        expect(podium).not.toBeNull();
        expect(podium.querySelector('.gm-gold .gm-podium-player-name').textContent).toBe('Alice');
        expect(podium.querySelector('.gm-gold .gm-podium-score-val').textContent).toContain('350 pts');

        // Leaderboard table MUST be rendered
        const table = area.querySelector('table');
        expect(table).not.toBeNull();
        const rows = table.querySelectorAll('tbody tr');
        expect(rows.length).toBe(3);
    });
});
