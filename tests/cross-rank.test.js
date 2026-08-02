import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../cross-rank.js';

const GM = window.GM;
const SETTINGS = window.GM_SETTINGS;

const FIXTURE = [
    {
        pseudo: 'AlphaKing', guild: 'ALPHA', power: 4500000000,
        svs_attended: 2, svs_total: 2, svs_rate: 100,
        gvg_attended: 1, gvg_total: 2, gvg_rate: 50,
        shadow_attended: 5, shadow_total: 10, shadow_rate: 50,
        glory_attended: 3, glory_total: 3, glory_rate: 100,
        global_attended: 8, global_total: 16, global_rate: 50,
    },
    {
        pseudo: 'OmegaStar', guild: 'OMEGA', power: 1200000,
        svs_attended: 0, svs_total: 2, svs_rate: 0,
        gvg_attended: 0, gvg_total: 2, gvg_rate: 0,
        shadow_attended: 2, shadow_total: 10, shadow_rate: 20,
        glory_attended: 3, glory_total: 3, glory_rate: 100,
        global_attended: 5, global_total: 16, global_rate: 31.3,
    },
    {
        pseudo: 'BetaKnight', guild: 'ALPHA', power: 0,
        svs_attended: 1, svs_total: 2, svs_rate: 50,
        gvg_attended: 2, gvg_total: 2, gvg_rate: 100,
        shadow_attended: 0, shadow_total: 10, shadow_rate: 0,
        glory_attended: 0, glory_total: 0, glory_rate: null,
        global_attended: 6, global_total: 16, global_rate: 37.5,
    },
    {
        pseudo: 'GammaGhost', guild: 'IMK', power: 8900,
        svs_attended: 0, svs_total: 0, svs_rate: null,
        gvg_attended: 0, gvg_total: 0, gvg_rate: null,
        shadow_attended: 0, shadow_total: 0, shadow_rate: null,
        glory_attended: 0, glory_total: 0, glory_rate: null,
        global_attended: 0, global_total: 0, global_rate: null,
    },
    {
        pseudo: '<b>Hax</b>', guild: 'BABE', power: 1000,
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

async function mockLoad(rpcFn) {
    GM.db = { rpc: rpcFn };
    await SETTINGS.load();
}

beforeEach(() => {
    document.body.innerHTML = '<div id="cross-rank-container"></div>';
    localStorage.setItem('gm_role', 'super_admin');
    GM.db = { rpc: async () => ({ data: FIXTURE, error: null }) };
});

afterEach(() => {
    GM.db = null;
    document.body.innerHTML = '';
});

describe('GM_SETTINGS cross-guild ranking', () => {
    it('renders players sorted by global rate descending by default', async () => {
        await SETTINGS.load();
        expect(rowPseudos()).toEqual(['AlphaKing', 'BetaKnight', 'OmegaStar', 'GammaGhost', '<b>Hax</b>']);
    });

    it('displays rates, counts and power', async () => {
        await SETTINGS.load();
        const text = container().textContent;
        expect(text).toContain('100%');
        expect(text).toContain('8/16');
        expect(text).toContain('4.5B');
        expect(text).toContain('1.2M');
        expect(text).toContain('8.9K');
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

    it('sorts by a rate column when its header is clicked', async () => {
        await SETTINGS.load();
        container().querySelector('th[data-sort="svs"]').click();
        expect(rowPseudos()).toEqual(['AlphaKing', 'BetaKnight', 'OmegaStar', 'GammaGhost', '<b>Hax</b>']);
        container().querySelector('th[data-sort="svs"]').click();
        expect(rowPseudos()).toEqual(['OmegaStar', 'BetaKnight', 'AlphaKing', 'GammaGhost', '<b>Hax</b>']);
    });

    it('sorts by power when the power header is clicked', async () => {
        await SETTINGS.load();
        container().querySelector('th[data-sort="power"]').click();
        expect(rowPseudos()).toEqual(['AlphaKing', 'OmegaStar', 'GammaGhost', '<b>Hax</b>', 'BetaKnight']);
    });

    it('filters players by search input', async () => {
        await SETTINGS.load();
        const search = document.getElementById('cross-rank-search');
        search.value = 'gamma';
        search.dispatchEvent(new Event('input'));
        expect(rowPseudos()).toEqual(['GammaGhost']);
    });

    it('filters players by guild select', async () => {
        await SETTINGS.load();
        const sel = document.getElementById('cross-rank-guild');
        sel.value = 'OMEGA';
        sel.dispatchEvent(new Event('change'));
        expect(rowPseudos()).toEqual(['OmegaStar']);
    });

    it('shows the player count', async () => {
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
        GM.db = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
        await SETTINGS.load();
        expect(container().querySelector('#cross-rank-retry')).not.toBeNull();
        expect(container().textContent).toContain('boom');
    });

    it('recovers via the retry button', async () => {
        GM.db = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
        await SETTINGS.load();
        GM.db = { rpc: async () => ({ data: FIXTURE, error: null }) };
        container().querySelector('#cross-rank-retry').click();
        await SETTINGS.load();
        expect(rowPseudos().length).toBe(5);
    });
});
