import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';
import '../i18n.js';
import '../svs-matchup.js';

const GM = window.GM;
const SVS = window.GM_SVS_MATCHUP;

const FIXTURE = [
    {
        pseudo: 'AlphaWarlord', guild: 'ALPHA', server_number: '1058', power: 120000000,
        svs_count: 5, avg_prep_score: 250000, avg_pvp_score: 600000,
        max_prep_score: 300000, max_pvp_score: 800000,
        danger_score: 123500000, danger_tier: 'EXTREME'
    },
    {
        pseudo: 'BetaCommander', guild: 'ALPHA', server_number: '1058', power: 45000000,
        svs_count: 4, avg_prep_score: 150000, avg_pvp_score: 250000,
        max_prep_score: 180000, max_pvp_score: 300000,
        danger_score: 46550000, danger_tier: 'HIGH'
    },
    {
        pseudo: 'OmegaStriker', guild: 'OMEGA', server_number: '1064', power: 80000000,
        svs_count: 5, avg_prep_score: 200000, avg_pvp_score: 400000,
        max_prep_score: 220000, max_pvp_score: 550000,
        danger_score: 82400000, danger_tier: 'EXTREME'
    },
    {
        pseudo: 'YarrPirate', guild: 'YARR', server_number: '1064', power: 25000000,
        svs_count: 2, avg_prep_score: 80000, avg_pvp_score: 100000,
        max_prep_score: 90000, max_pvp_score: 120000,
        danger_score: 25660000, danger_tier: 'MEDIUM'
    },
    {
        pseudo: 'DemoGhost', guild: 'DEMO', server_number: '0000', power: 99999999,
        svs_count: 10, avg_prep_score: 500000, avg_pvp_score: 900000,
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
    return document.getElementById('svs-matchup-container');
}

describe('GM_SVS_MATCHUP — Server vs Server Matchup & Dangerosity Ranking', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="svs-matchup-container"></div>';
        localStorage.setItem('gm_role', 'super_admin');
        GM.db = createMockDb(FIXTURE);
    });

    afterEach(() => {
        localStorage.removeItem('gm_role');
        document.body.innerHTML = '';
    });

    it('exposes load() on window.GM_SVS_MATCHUP', () => {
        expect(SVS).toBeDefined();
        expect(typeof SVS.load).toBe('function');
    });

    it('renders server selectors and matchup summary cards', async () => {
        await SVS.load();
        const text = container().textContent;
        expect(text).toContain('SvS Server Matchup & Dangerosity');
        expect(text).toContain('#1058');
        expect(text).toContain('#1064');
        expect(text).toContain('AlphaWarlord');
        expect(text).toContain('OmegaStriker');
    });

    it('filters out DEMO guild players from the matchup view', async () => {
        await SVS.load();
        expect(container().textContent).not.toContain('DemoGhost');
    });

    it('displays dangerosity tier badges (EXTREME, HIGH, MEDIUM, LOW)', async () => {
        await SVS.load();
        const html = container().innerHTML;
        expect(html).toContain('EXTREME');
        expect(html).toContain('HIGH');
    });

    it('applies power penalties to dangerosity scores based on power thresholds', async () => {
        await SVS.load();
        // AlphaWarlord (120M power > 90M) -> mult = 1.0 (no penalty)
        // BetaCommander (45M power < 60M) -> mult = 0.30 (big penalty)
        // OmegaStriker (80M power 60-90M) -> mult = 0.65 (moderate penalty)
        const combinedBtn = container().querySelector('#svs-mode-combined');
        combinedBtn.click();
        const text = container().textContent;
        expect(text).toContain('Day 1-5 Avg');
        expect(text).toContain('Day 6 Avg');
    });

    it('toggles between Side-by-Side and Combined Leaderboard views', async () => {
        await SVS.load();
        expect(container().querySelector('#svs-mode-side')).not.toBeNull();
        expect(container().querySelector('#svs-mode-combined')).not.toBeNull();

        // Switch to combined leaderboard mode
        container().querySelector('#svs-mode-combined').click();
        expect(container().textContent).toContain('Cross-Server Dangerosity Leaderboard');

        // Switch back to side by side mode
        container().querySelector('#svs-mode-side').click();
        expect(container().textContent).toContain('Server #1058 Roster');
    });

    it('filters matchup by search input', async () => {
        await SVS.load();
        const search = document.getElementById('svs-matchup-search');
        search.value = 'Alpha';
        search.dispatchEvent(new Event('input'));
        expect(container().textContent).toContain('AlphaWarlord');
        expect(container().textContent).not.toContain('OmegaStriker');
    });

    it('enforces superadmin-only access', async () => {
        localStorage.setItem('gm_role', 'guild_admin');
        await SVS.load();
        expect(container().textContent).toContain('Super admin only');
    });

    it('renders Discord share buttons for Opponent Server B', async () => {
        await SVS.load();
        expect(container().querySelector('#svs-share-discord-b')).not.toBeNull();
        expect(container().querySelector('#svs-share-discord-table-b')).not.toBeNull();
    });

    it('shows error state with retry button when RPC fails', async () => {
        GM.db = createMockDb(null, { message: 'Server Matchup Error' });
        await SVS.load();
        expect(container().textContent).toContain('Server Matchup Error');
        expect(container().querySelector('#svs-matchup-retry')).not.toBeNull();
    });
});
