import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../gvg-matchup.js';

const GM = window.GM;
const GVG = window.GM_GVG_MATCHUP;

const FIXTURE = [
    {
        pseudo: 'AlphaWarlord', guild: 'ALPHA', server_number: '1058', power: 120000000,
        gvg_count: 5, avg_prep_score: 250000, avg_pvp_score: 600000,
        max_prep_score: 300000, max_pvp_score: 800000,
        danger_score: 123500000, danger_tier: 'EXTREME'
    },
    {
        pseudo: 'BetaCommander', guild: 'ALPHA', server_number: '1058', power: 45000000,
        gvg_count: 4, avg_prep_score: 150000, avg_pvp_score: 250000,
        max_prep_score: 180000, max_pvp_score: 300000,
        danger_score: 46550000, danger_tier: 'HIGH'
    },
    {
        pseudo: 'OmegaStriker', guild: 'OMEGA', server_number: '1064', power: 80000000,
        gvg_count: 5, avg_prep_score: 200000, avg_pvp_score: 400000,
        max_prep_score: 220000, max_pvp_score: 550000,
        danger_score: 82400000, danger_tier: 'EXTREME'
    },
    {
        pseudo: 'YarrPirate', guild: 'YARR', server_number: '1064', power: 25000000,
        gvg_count: 2, avg_prep_score: 80000, avg_pvp_score: 100000,
        max_prep_score: 90000, max_pvp_score: 120000,
        danger_score: 25660000, danger_tier: 'MEDIUM'
    },
    {
        pseudo: 'DemoGhost', guild: 'DEMO', server_number: '0000', power: 99999999,
        gvg_count: 10, avg_prep_score: 500000, avg_pvp_score: 900000,
        max_prep_score: 999999, max_pvp_score: 999999,
        danger_score: 999999999, danger_tier: 'EXTREME'
    }
];

function createMockDb(data, error = null) {
    return {
        rpc: () => {
            const p = Promise.resolve({ data, error });
            p.range = () => p;
            return p;
        }
    };
}

function container() {
    return document.getElementById('gvg-matchup-container');
}

describe('GM_GVG_MATCHUP — Guild vs Guild Matchup & Dangerosity Ranking', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="gvg-matchup-container"></div>';
        localStorage.setItem('gm_role', 'super_admin');
        GM.db = createMockDb(FIXTURE);
    });

    afterEach(() => {
        localStorage.removeItem('gm_role');
        document.body.innerHTML = '';
    });

    it('exposes load() on window.GM_GVG_MATCHUP', () => {
        expect(GVG).toBeDefined();
        expect(typeof GVG.load).toBe('function');
    });

    it('renders guild selectors (Guild A vs Guild B) and player matchup cards', async () => {
        await GVG.load();
        const text = container().textContent;
        expect(text).toContain('GvG Guild vs Guild Matchup');
        expect(text).toContain('ALPHA');
        expect(text).toContain('OMEGA');
        expect(text).toContain('AlphaWarlord');
        expect(text).toContain('OmegaStriker');
    });

    it('filters out DEMO guild players from the GvG matchup view', async () => {
        await GVG.load();
        expect(container().textContent).not.toContain('DemoGhost');
    });

    it('displays dangerosity tier badges for players (EXTREME, HIGH, MEDIUM, LOW)', async () => {
        await GVG.load();
        const html = container().innerHTML;
        expect(html).toContain('EXTREME');
        expect(html).toContain('HIGH');
    });

    it('toggles between Side-by-Side and Combined Player Leaderboard views', async () => {
        await GVG.load();
        expect(container().querySelector('#gvg-mode-side')).not.toBeNull();
        expect(container().querySelector('#gvg-mode-combined')).not.toBeNull();

        // Switch to combined leaderboard mode
        container().querySelector('#gvg-mode-combined').click();
        expect(container().textContent).toContain('Cross-Guild GvG Player Dangerosity Leaderboard');

        // Switch back to side by side mode
        container().querySelector('#gvg-mode-side').click();
        expect(container().textContent).toContain('ALPHA Roster');
    });

    it('filters player matchup by search input', async () => {
        await GVG.load();
        const search = document.getElementById('gvg-matchup-search');
        search.value = 'Alpha';
        search.dispatchEvent(new Event('input'));
        expect(container().textContent).toContain('AlphaWarlord');
        expect(container().textContent).not.toContain('OmegaStriker');
    });

    it('enforces superadmin-only access', async () => {
        localStorage.setItem('gm_role', 'guild_admin');
        await GVG.load();
        expect(container().textContent).toContain('Super admin only');
    });

    it('shows error state with retry button when RPC fails', async () => {
        GM.db = createMockDb(null, { message: 'GvG Matchup Error' });
        await GVG.load();
        expect(container().textContent).toContain('GvG Matchup Error');
        expect(container().querySelector('#gvg-matchup-retry')).not.toBeNull();
    });
});
