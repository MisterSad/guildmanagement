import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../overview.js';

const GM = window.GM;
const OV = window.GM_OVERVIEW;

const W_CUR = '2026-08-03';
const W_PREV = '2026-07-27';

// ── Mock query builder (mirrors the db.from wrapper contract) ──────────────
class MockBuilder {
    constructor(table, rows) {
        this.table = table;
        this.rows = rows || [];
        this.where = [];
    }
    select() { return this; }
    eq(field, value) { this.where.push([field, value]); return this; }
    order() { return this; }
    limit() { return this; }
    or() { return this; }
    then(resolve) {
        let rows = this.rows;
        for (const [field, value] of this.where) {
            rows = rows.filter((r) => r[field] === value);
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve);
    }
}

function makeDb() {
    return {
        from: (table) => {
            if (table === 'guild_members') {
                return new MockBuilder(table, [
                    { id: 1, guild: 'ALPHA', pseudo: 'Rem', created_at: '2026-08-01T00:00:00Z', overall_power: 500000000 },
                    { id: 2, guild: 'ALPHA', pseudo: 'ODIN', created_at: '2026-08-01T00:00:00Z', overall_power: 200000000 }
                ]);
            }
            if (table === 'event_status') return new MockBuilder(table, []);
            if (table === 'event_participants') {
                return new MockBuilder(table, [
                    { pseudo: 'Rem',   guild: 'ALPHA', event_name: 'Glory', week_start: W_PREV, score: 470000000 },
                    { pseudo: 'ODIN',  guild: 'ALPHA', event_name: 'Glory', week_start: W_PREV, score: 120000000 },
                    { pseudo: 'Rem',   guild: 'ALPHA', event_name: 'Glory', week_start: W_CUR, score: 478539754 },
                    { pseudo: 'ODIN',  guild: 'ALPHA', event_name: 'Glory', week_start: W_CUR, score: 128470031 },
                    { pseudo: 'Newbie', guild: 'ALPHA', event_name: 'Glory', week_start: W_CUR, score: 5000000 }
                ]);
            }
            if (table === 'sanctions') return new MockBuilder(table, []);
            if (table === 'guild_transfers') return new MockBuilder(table, []);
            return new MockBuilder(table, []);
        }
    };
}

let containerEl;

beforeEach(() => {
    localStorage.clear();
    window.currentGuildRestriction = 'ALPHA';
    window.currentGuild = 'ALPHA';
    window.guildsData = { ALPHA: { type: 'Unlimited' } };
    GM.config = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
    GM.db = makeDb();
    document.body.innerHTML =
        '<main class="dashboard-content tab-panel" id="gm-overview">' +
            '<div data-gm-overview-content></div>' +
        '</main>';
    containerEl = document.getElementById('gm-overview');
});

afterEach(() => {
    GM.db = null;
    GM.config = null;
    document.body.innerHTML = '';
    delete window.currentGuildRestriction;
});

describe('GM_OVERVIEW Glory this week tile', () => {
    it('shows the glory gained this week, not the sum of all scores', async () => {
        await OV.load();
        const text = containerEl.textContent;

        // Sum of all this-week scores = 478539754 + 128470031 + 5000000 = 612,009,785
        expect(text).not.toContain('612M');
        expect(text).not.toContain('612,009,785');

        // Gained = (478539754-470000000) + (128470031-120000000) + 5000000 (new player) = 22,009,785
        expect(text).toContain('22M');
    });

    it('treats a score decrease as zero gain for that member', async () => {
        // Swap: this week's Rem score is BELOW last week (glory reset case).
        GM.db = makeDb();
        // Replace the builder to return a decreased score for Rem.
        GM.db.from = (table) => {
            if (table === 'event_participants') {
                return new MockBuilder(table, [
                    { pseudo: 'Rem',  guild: 'ALPHA', event_name: 'Glory', week_start: W_PREV, score: 478539754 },
                    { pseudo: 'Rem',  guild: 'ALPHA', event_name: 'Glory', week_start: W_CUR, score: 100000000 },
                    { pseudo: 'ODIN', guild: 'ALPHA', event_name: 'Glory', week_start: W_PREV, score: 120000000 },
                    { pseudo: 'ODIN', guild: 'ALPHA', event_name: 'Glory', week_start: W_CUR, score: 128470031 }
                ]);
            }
            return new MockBuilder(table, []);
        };
        await OV.load();
        // Only ODIN gained: 128470031 - 120000000 = 8,470,031 -> 8.5M
        expect(containerEl.textContent).toContain('8.5M');
        expect(containerEl.textContent).not.toContain('228M');
    });
});
