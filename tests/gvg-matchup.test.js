import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../gvg-matchup.js';

const GM = window.GM;
const GVG = window.GM_GVG_MATCHUP;

const FIXTURE = [
    {
        guild: 'ALPHA', server_number: '1058', member_count: 85,
        total_power: 4500000000, avg_power: 52941176, gvg_count: 5,
        avg_prep_score: 450000, avg_pvp_score: 1200000,
        total_prep_score: 38250000, total_pvp_score: 102000000,
        danger_score: 5086500000, danger_tier: 'EXTREME'
    },
    {
        guild: 'OMEGA', server_number: '1064', member_count: 70,
        total_power: 2800000000, avg_power: 40000000, gvg_count: 4,
        avg_prep_score: 300000, avg_pvp_score: 800000,
        total_prep_score: 21000000, total_pvp_score: 56000000,
        danger_score: 2185400000, danger_tier: 'HIGH'
    },
    {
        guild: 'YARR', server_number: '1064', member_count: 50,
        total_power: 1200000000, avg_power: 24000000, gvg_count: 3,
        avg_prep_score: 180000, avg_pvp_score: 400000,
        total_prep_score: 9000000, total_pvp_score: 20000000,
        danger_score: 527200000, danger_tier: 'MEDIUM'
    },
    {
        guild: 'DEMO', server_number: '0000', member_count: 10,
        total_power: 9999999999, avg_power: 999999999, gvg_count: 10,
        avg_prep_score: 999999, avg_pvp_score: 999999,
        total_prep_score: 9999999, total_pvp_score: 9999999,
        danger_score: 9999999999, danger_tier: 'EXTREME'
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

describe('GM_GVG_MATCHUP — Server vs Server Guild Matchup & Dangerosity Ranking', () => {
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

    it('renders server selectors and guild matchup summary cards', async () => {
        await GVG.load();
        const text = container().textContent;
        expect(text).toContain('GvG Guild Matchup & Dangerosity');
        expect(text).toContain('#1058');
        expect(text).toContain('#1064');
        expect(text).toContain('ALPHA');
        expect(text).toContain('OMEGA');
    });

    it('filters out DEMO guild from the GvG matchup view', async () => {
        await GVG.load();
        expect(container().textContent).not.toContain('DEMO');
    });

    it('displays dangerosity tier badges for guilds (EXTREME, HIGH, MEDIUM, LOW)', async () => {
        await GVG.load();
        const html = container().innerHTML;
        expect(html).toContain('EXTREME');
        expect(html).toContain('HIGH');
    });

    it('toggles between Side-by-Side and Combined Guild Leaderboard views', async () => {
        await GVG.load();
        expect(container().querySelector('#gvg-mode-side')).not.toBeNull();
        expect(container().querySelector('#gvg-mode-combined')).not.toBeNull();

        // Switch to combined leaderboard mode
        container().querySelector('#gvg-mode-combined').click();
        expect(container().textContent).toContain('Cross-Server GvG Guild Dangerosity Leaderboard');

        // Switch back to side by side mode
        container().querySelector('#gvg-mode-side').click();
        expect(container().textContent).toContain('Server #1058 Guilds');
    });

    it('filters guild matchup by search input', async () => {
        await GVG.load();
        const search = document.getElementById('gvg-matchup-search');
        search.value = 'ALPHA';
        search.dispatchEvent(new Event('input'));
        expect(container().textContent).toContain('ALPHA');
        expect(container().textContent).not.toContain('OMEGA');
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
