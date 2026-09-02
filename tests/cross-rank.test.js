import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../cross-rank.js';

const GM = window.GM;
const SETTINGS = window.GM_SETTINGS;

const FIXTURE = [
    {
        pseudo: 'AlphaKing', guild: 'ALPHA', server_number: '1058', power: 4500000000,
        svs_attended: 2, svs_total: 2, svs_rate: 100, svs_avg_prep: 2500000, svs_avg_pvp: 6000000,
        gvg_attended: 1, gvg_total: 2, gvg_rate: 50, gvg_avg_prep: 1800000, gvg_avg_pvp: 4000000,
        day6_pvp_score: 20000000, day6_score: 90.0,
        shadow_attended: 5, shadow_total: 10, shadow_rate: 50,
        glory_attended: 3, glory_total: 350000, glory_total_weeks: 3, glory_rate: 100, glory_score: 85.0,
        global_attended: 8, global_total: 16, global_rate: 50,
        combat_density_score: 64.0,
        draft_score: 72.5, scouting_tier: 'WARRIOR'
    },
    {
        pseudo: 'OmegaStar', guild: 'OMEGA', server_number: '1058', power: 1200000,
        svs_attended: 0, svs_total: 2, svs_rate: 0, svs_avg_prep: 0, svs_avg_pvp: 0,
        gvg_attended: 0, gvg_total: 2, gvg_rate: 0, gvg_avg_prep: 0, gvg_avg_pvp: 0,
        day6_pvp_score: 0, day6_score: 0.0,
        shadow_attended: 2, shadow_total: 10, shadow_rate: 20,
        glory_attended: 3, glory_total: 120000, glory_total_weeks: 3, glory_rate: 100, glory_score: 62.0,
        global_attended: 5, global_total: 16, global_rate: 31.3,
        combat_density_score: 22.0,
        draft_score: 13.8, scouting_tier: 'RECRUIT'
    },
    {
        pseudo: 'BetaKnight', guild: 'ALPHA', server_number: '1064', power: 0,
        svs_attended: 1, svs_total: 2, svs_rate: 50, svs_avg_prep: 1200000, svs_avg_pvp: 3000000,
        gvg_attended: 2, gvg_total: 2, gvg_rate: 100, gvg_avg_prep: 1500000, gvg_avg_pvp: 3500000,
        day6_pvp_score: 13000000, day6_score: 69.0,
        shadow_attended: 0, shadow_total: 10, shadow_rate: 0,
        glory_attended: 0, glory_total: 0, glory_total_weeks: 0, glory_rate: null, glory_score: null,
        global_attended: 6, global_total: 16, global_rate: 37.5,
        draft_score: 41.6, scouting_tier: 'PILLAR'
    },
    {
        pseudo: 'GammaGhost', guild: 'IMK', server_number: '0000', power: 8900,
        svs_attended: 0, svs_total: 0, svs_rate: null,
        gvg_attended: 0, gvg_total: 0, gvg_rate: null,
        shadow_attended: 0, shadow_total: 0, shadow_rate: null,
        glory_attended: 0, glory_total: 0, glory_total_weeks: 0, glory_rate: null, glory_score: null,
        global_attended: 0, global_total: 0, global_rate: null,
        draft_score: null, day6_score: null, scouting_tier: 'RECRUIT'
    },
    {
        pseudo: '<b>Hax</b>', guild: 'BABE', server_number: '1064', power: 1000,
        svs_attended: 0, svs_total: 0, svs_rate: null,
        gvg_attended: 0, gvg_total: 0, gvg_rate: null,
        shadow_attended: 0, shadow_total: 0, shadow_rate: null,
        glory_attended: 0, glory_total: 0, glory_total_weeks: 0, glory_rate: null, glory_score: null,
        global_attended: 0, global_total: 0, global_rate: null,
        draft_score: null, day6_score: null, scouting_tier: 'RECRUIT'
    },
];

function container() {
    return document.getElementById('cross-rank-container');
}

function rowPseudos() {
    return Array.prototype.map.call(
        container().querySelectorAll('tbody tr .gm-member-pseudo'),
        (el) => el.textContent
    );
}

function createMockDb(data, error = null) {
    return {
        rpc: () => {
            const p = Promise.resolve({ data, error });
            p.range = () => p;
            return p;
        }
    };
}

// Respects the .range(from, to) args so pagination can be exercised: each
// db.rpc() call returns a thenable slicing `fullData` to whatever range was
// last requested on it, mirroring how the real Supabase client and the
// production load() loop (fresh db.rpc() call per page) interact.
function createPagedMockDb(fullData) {
    return {
        rpc: () => {
            var bounds = [0, fullData.length - 1];
            var thenable = {
                range: function (from, to) {
                    bounds = [from, to];
                    return thenable;
                },
                then: function (resolve, reject) {
                    var page = fullData.slice(bounds[0], bounds[1] + 1);
                    return Promise.resolve({ data: page, error: null }).then(resolve, reject);
                }
            };
            return thenable;
        }
    };
}

beforeEach(() => {
    document.body.innerHTML = '<div id="cross-rank-container"></div>';
    localStorage.setItem('gm_role', 'super_admin');
    GM.db = createMockDb(FIXTURE);
});

afterEach(() => {
    GM.db = null;
    document.body.innerHTML = '';
});

describe('GM_SETTINGS cross-guild Draft Mercato & Inter-Server Scouting Engine', () => {
    it('renders players sorted by composite Draft Score descending by default', async () => {
        await SETTINGS.load();
        expect(rowPseudos()).toEqual(['AlphaKing', 'BetaKnight', 'OmegaStar', 'GammaGhost', '<b>Hax</b>']);
    });

    it('displays server, guild, rates, counts, Day 6 (0-100%), Glory (0-100%), and power', async () => {
        await SETTINGS.load();
        const text = container().textContent;
        expect(text).toContain('#1058');
        expect(text).toContain('#1064');
        expect(text).toContain('#0000');
        expect(text).toContain('73%'); // Draft score rounded
        expect(text).toContain('90%'); // Day 6 score (0-100%)
        expect(text).toContain('85%'); // Glory score (0-100%)
        expect(text).toContain('5/10');
        expect(text).toContain('4.5B');
        expect(text).toContain('1.2M');
        expect(text).toContain('8.9K');
    });

    it('renders the Glory column with 0-100% normalized performance rating', async () => {
        await SETTINGS.load();
        const headers = Array.from(container().querySelectorAll('th')).map(th => th.textContent.trim());
        expect(headers.some(h => h.includes('Glory'))).toBe(true);
    });

    it('renders the Day 6 PvP column with 0-100% combat battle rating', async () => {
        await SETTINGS.load();
        const headers = Array.from(container().querySelectorAll('th')).map(th => th.textContent.trim());
        expect(headers.some(h => h.includes('Day 6'))).toBe(true);
    });

    it('renders the Shadowfront column as a priority attendance pillar', async () => {
        await SETTINGS.load();
        const headers = Array.from(container().querySelectorAll('th')).map(th => th.textContent.trim());
        expect(headers.some(h => h.includes('Shadowfront'))).toBe(true);
    });

    it('renders a dash for players without recorded data', async () => {
        await SETTINGS.load();
        const row = container().querySelector('tbody tr:nth-child(4)');
        expect(row.textContent).toContain('-');
    });

    it('escapes player pseudos against XSS injection', async () => {
        await SETTINGS.load();
        expect(container().innerHTML).not.toContain('<b>Hax</b>');
        expect(container().querySelector('tbody tr:nth-child(5) .gm-member-pseudo').textContent).toBe('<b>Hax</b>');
    });

    it('sorts by server column when server header is clicked', async () => {
        await SETTINGS.load();
        container().querySelector('th[data-sort="server"]').click();
        // Server descending: '1064' (Hax power 1000 > BetaKnight power 0), '1058' (AlphaKing, OmegaStar), '0000' (GammaGhost)
        expect(rowPseudos()).toEqual(['<b>Hax</b>', 'BetaKnight', 'AlphaKing', 'OmegaStar', 'GammaGhost']);
        container().querySelector('th[data-sort="server"]').click();
        // Server ascending: '0000' (GammaGhost), '1058' (AlphaKing, OmegaStar), '1064' (Hax, BetaKnight)
        expect(rowPseudos()).toEqual(['GammaGhost', 'AlphaKing', 'OmegaStar', '<b>Hax</b>', 'BetaKnight']);
    });

    it('sorts by power when power header is clicked', async () => {
        await SETTINGS.load();
        container().querySelector('th[data-sort="power"]').click();
        expect(rowPseudos()).toEqual(['AlphaKing', 'OmegaStar', 'GammaGhost', '<b>Hax</b>', 'BetaKnight']);
    });

    it('sorts by Day 6 battle score when day 6 header is clicked', async () => {
        await SETTINGS.load();
        container().querySelector('th[data-sort="day6"]').click();
        // Day 6 descending: AlphaKing (90%), BetaKnight (69%), OmegaStar (0%), GammaGhost (null), Hax (null)
        expect(rowPseudos()).toEqual(['AlphaKing', 'BetaKnight', 'OmegaStar', 'GammaGhost', '<b>Hax</b>']);
    });

    it('sorts by Glory score when glory header is clicked', async () => {
        await SETTINGS.load();
        container().querySelector('th[data-sort="glory"]').click();
        // Glory descending: AlphaKing (85%), OmegaStar (62%), BetaKnight (null), GammaGhost (null), Hax (null)
        expect(rowPseudos()).toEqual(['AlphaKing', 'OmegaStar', 'GammaGhost', '<b>Hax</b>', 'BetaKnight']);
    });

    it('filters players by toggling a migration server chip', async () => {
        await SETTINGS.load();
        const chip1064 = Array.from(container().querySelectorAll('button[data-server-chip]'))
            .find((b) => b.textContent.trim() === '#1064');
        chip1064.click();
        expect(rowPseudos()).toEqual(['BetaKnight', '<b>Hax</b>']);
    });

    it('supports selecting multiple server chips at once for migration events', async () => {
        await SETTINGS.load();
        const chips = () => Array.from(container().querySelectorAll('button[data-server-chip]'));
        chips().find((b) => b.textContent.trim() === '#1064').click();
        chips().find((b) => b.textContent.trim() === '#1058').click();
        expect(rowPseudos().slice().sort()).toEqual(['<b>Hax</b>', 'AlphaKing', 'BetaKnight', 'OmegaStar'].sort());

        container().querySelector('button[data-server-chip="ALL"]').click();
        expect(rowPseudos().length).toBe(5);
    });

    it('filters players by guild select dropdown', async () => {
        await SETTINGS.load();
        const sel = document.getElementById('cross-rank-guild');
        sel.value = 'OMEGA';
        sel.dispatchEvent(new Event('change'));
        expect(rowPseudos()).toEqual(['OmegaStar']);
    });

    it('filters players by preset scouting focus buttons', async () => {
        await SETTINGS.load();
        const day6Btn = container().querySelector('button[data-preset="DAY6"]');
        day6Btn.click();
        expect(rowPseudos()).toEqual(['AlphaKing', 'BetaKnight']);

        const shadowBtn = container().querySelector('button[data-preset="SHADOW"]');
        shadowBtn.click();
        expect(rowPseudos()).toEqual(['AlphaKing']);

        const gloryBtn = container().querySelector('button[data-preset="GLORY"]');
        gloryBtn.click();
        expect(rowPseudos()).toEqual(['AlphaKing', 'OmegaStar']);

        const densityBtn = container().querySelector('button[data-preset="DENSITY"]');
        densityBtn.click();
        expect(rowPseudos()).toEqual(['AlphaKing']);
    });

    it('renders the Combat Density column and sorts by it', async () => {
        await SETTINGS.load();
        const headers = Array.from(container().querySelectorAll('th')).map((th) => th.textContent.trim());
        expect(headers.some((h) => h.includes('Density'))).toBe(true);

        const text = container().textContent;
        expect(text).toContain('64%');
        expect(text).toContain('22%');

        container().querySelector('th[data-sort="density"]').click();
        // Density descending: AlphaKing (64%), OmegaStar (22%), then the
        // three players with no density data tie-broken by power descending.
        expect(rowPseudos()).toEqual(['AlphaKing', 'OmegaStar', 'GammaGhost', '<b>Hax</b>', 'BetaKnight']);
    });

    it('filters players by search input including server query', async () => {
        await SETTINGS.load();
        const search = document.getElementById('cross-rank-search');
        search.value = '#0000';
        search.dispatchEvent(new Event('input'));
        expect(rowPseudos()).toEqual(['GammaGhost']);
    });

    it('shows player candidate count and total', async () => {
        await SETTINGS.load();
        expect(container().textContent).toContain('5 candidates');
    });

    it('shows a denied state for non-super-admin callers', async () => {
        localStorage.setItem('gm_role', 'guild_admin');
        await SETTINGS.load();
        expect(container().textContent).toContain('Super admin only');
        expect(container().querySelectorAll('tbody tr').length).toBe(0);
        localStorage.removeItem('gm_role');
    });

    it('excludes players from the DEMO guild', async () => {
        const demoFixture = [
            ...FIXTURE,
            { pseudo: 'DemoUser', guild: 'DEMO', server_number: '0000', power: 99999, global_rate: 100, draft_score: 100 }
        ];
        GM.db = createMockDb(demoFixture);
        await SETTINGS.load();
        expect(rowPseudos()).not.toContain('DemoUser');
        expect(rowPseudos().length).toBe(5);
    });

    it('shows an error state with a retry button when the RPC fails', async () => {
        GM.db = createMockDb(null, { message: 'boom' });
        await SETTINGS.load();
        expect(container().querySelector('#cross-rank-retry')).not.toBeNull();
        expect(container().textContent).toContain('boom');
    });

    it('pages through the RPC in blocks of 1000 instead of truncating the candidate pool', async () => {
        const bigFixture = [];
        for (let i = 0; i < 1250; i++) {
            bigFixture.push({
                pseudo: 'Player' + i, guild: 'ALPHA', server_number: '1058', power: 1000 + i,
                draft_score: i % 100
            });
        }
        GM.db = createPagedMockDb(bigFixture);
        await SETTINGS.load();
        expect(container().textContent).toContain('1250 candidates');
        expect(container().querySelectorAll('tbody tr').length).toBe(1250);
    });
});
