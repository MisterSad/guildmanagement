import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../cross-rank.js';

const GM = window.GM;
const SETTINGS = window.GM_SETTINGS;

const FIXTURE = [
    {
        pseudo: 'AlphaKing', guild: 'ALPHA', server_number: '1058', power: 4500000000,
        svs_attended: 2, svs_total: 2, svs_rate: 100,
        gvg_attended: 1, gvg_total: 2, gvg_rate: 50,
        shadow_attended: 5, shadow_total: 10, shadow_rate: 50,
        glory_attended: 3, glory_total: 3, glory_rate: 100,
        global_attended: 8, global_total: 16, global_rate: 50,
    },
    {
        pseudo: 'OmegaStar', guild: 'OMEGA', server_number: '1058', power: 1200000,
        svs_attended: 0, svs_total: 2, svs_rate: 0,
        gvg_attended: 0, gvg_total: 2, gvg_rate: 0,
        shadow_attended: 2, shadow_total: 10, shadow_rate: 20,
        glory_attended: 3, glory_total: 3, glory_rate: 100,
        global_attended: 5, global_total: 16, global_rate: 31.3,
    },
    {
        pseudo: 'BetaKnight', guild: 'ALPHA', server_number: '1064', power: 0,
        svs_attended: 1, svs_total: 2, svs_rate: 50,
        gvg_attended: 2, gvg_total: 2, gvg_rate: 100,
        shadow_attended: 0, shadow_total: 10, shadow_rate: 0,
        glory_attended: 0, glory_total: 0, glory_rate: null,
        global_attended: 6, global_total: 16, global_rate: 37.5,
    },
    {
        pseudo: 'GammaGhost', guild: 'IMK', server_number: '0000', power: 8900,
        svs_attended: 0, svs_total: 0, svs_rate: null,
        gvg_attended: 0, gvg_total: 0, gvg_rate: null,
        shadow_attended: 0, shadow_total: 0, shadow_rate: null,
        glory_attended: 0, glory_total: 0, glory_rate: null,
        global_attended: 0, global_total: 0, global_rate: null,
    },
    {
        pseudo: '<b>Hax</b>', guild: 'BABE', server_number: '1064', power: 1000,
        svs_attended: 0, svs_total: 0, svs_rate: null,
        gvg_attended: 0, gvg_total: 0, gvg_rate: null,
        shadow_attended: 0, shadow_total: 0, shadow_rate: null,
        glory_attended: 0, glory_total: 0, glory_rate: null,
        global_attended: 0, global_total: 0, global_rate: null,
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

beforeEach(() => {
    document.body.innerHTML = '<div id="cross-rank-container"></div>';
    localStorage.setItem('gm_role', 'super_admin');
    GM.db = createMockDb(FIXTURE);
});

afterEach(() => {
    GM.db = null;
    document.body.innerHTML = '';
});

describe('GM_SETTINGS cross-guild Draft Mercato ranking', () => {
    it('renders players sorted by global rate descending by default', async () => {
        await SETTINGS.load();
        expect(rowPseudos()).toEqual(['AlphaKing', 'BetaKnight', 'OmegaStar', 'GammaGhost', '<b>Hax</b>']);
    });

    it('displays server, guild, rates, counts and power', async () => {
        await SETTINGS.load();
        const text = container().textContent;
        expect(text).toContain('#1058');
        expect(text).toContain('#1064');
        expect(text).toContain('#0000');
        expect(text).toContain('100%');
        expect(text).toContain('8/16');
        expect(text).toContain('4.5B');
        expect(text).toContain('1.2M');
        expect(text).toContain('8.9K');
    });

    it('does NOT render the Glory column', async () => {
        await SETTINGS.load();
        const headers = Array.from(container().querySelectorAll('th')).map(th => th.textContent.trim());
        expect(headers.some(h => h.includes('Glory'))).toBe(false);
    });

    it('renders a dash for players without recorded data', async () => {
        await SETTINGS.load();
        const row = container().querySelector('tbody tr:nth-child(4)');
        expect(row.textContent).toContain('—');
    });

    it('escapes player pseudos', async () => {
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

    it('filters players by server select dropdown', async () => {
        await SETTINGS.load();
        const serverSel = document.getElementById('cross-rank-server');
        serverSel.value = '1064';
        serverSel.dispatchEvent(new Event('change'));
        expect(rowPseudos()).toEqual(['BetaKnight', '<b>Hax</b>']);
    });

    it('filters players by guild select dropdown', async () => {
        await SETTINGS.load();
        const sel = document.getElementById('cross-rank-guild');
        sel.value = 'OMEGA';
        sel.dispatchEvent(new Event('change'));
        expect(rowPseudos()).toEqual(['OmegaStar']);
    });

    it('filters players by search input including server query', async () => {
        await SETTINGS.load();
        const search = document.getElementById('cross-rank-search');
        search.value = '#0000';
        search.dispatchEvent(new Event('input'));
        expect(rowPseudos()).toEqual(['GammaGhost']);
    });

    it('shows player count and total', async () => {
        await SETTINGS.load();
        expect(container().textContent).toContain('5 players');
    });

    it('shows a denied state for non-super-admin callers', async () => {
        localStorage.setItem('gm_role', 'guild_admin');
        await SETTINGS.load();
        expect(container().textContent).toContain('Super admin only');
        expect(container().querySelectorAll('tbody tr').length).toBe(0);
        localStorage.removeItem('gm_role');
    });

    it('shows an error state with a retry button when the RPC fails', async () => {
        GM.db = createMockDb(null, { message: 'boom' });
        await SETTINGS.load();
        expect(container().querySelector('#cross-rank-retry')).not.toBeNull();
        expect(container().textContent).toContain('boom');
    });
});
