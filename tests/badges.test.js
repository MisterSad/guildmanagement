import { describe, it, expect } from 'vitest';
import '../badges.js';

const compute = window.GM_BADGES.computeBadges;

function find(catalog, id) {
    let found = null;
    catalog.categories.forEach((cat) => {
        cat.badges.forEach((b) => {
            if (b.id === id) found = b;
        });
    });
    return found;
}

describe('GM_BADGES badge catalog', () => {
    it('exposes the expected total badge count', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 0 });
        expect(c.total).toBe(41);
        expect(c.categories).toHaveLength(5);
    });

    it('orders categories as Ranks, Seniority, Power, Participation, Glory', () => {
        const c = compute({});
        expect(c.categories.map((cat) => cat.id)).toEqual(['rank', 'tenure', 'power', 'part', 'glory']);
    });

    it('handles empty input without throwing', () => {
        const c = compute(null);
        expect(c.total).toBe(41);
        // default rank is R1, so only the baseline Initiate badge is earned
        expect(c.earned).toBe(1);
    });
});

describe('GM_BADGES glory badges', () => {
    it('locks every glory badge at zero', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 0, glory_best: 0 });
        expect(find(c, 'glory_1k').earned).toBe(false);
        expect(find(c, 'glory_1m').earned).toBe(false);
    });

    it('250K best glory unlocks Spark, Radiant, Luminous and Dazzling', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 0, glory_best: 250000 });
        expect(find(c, 'glory_1k').earned).toBe(true);
        expect(find(c, 'glory_100k').earned).toBe(true);
        expect(find(c, 'glory_500k').earned).toBe(false);
        expect(find(c, 'glory_500k').progress).toBe(50);
    });

    it('1M best glory unlocks every glory badge', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 0, glory_best: 1000000 });
        expect(find(c, 'glory_1m').earned).toBe(true);
    });
});

describe('GM_BADGES rank badges (cumulative)', () => {
    it('a fresh R1 player only earns the R1 badge', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 0 });
        expect(find(c, 'rank_r1').earned).toBe(true);
        expect(find(c, 'rank_r2').earned).toBe(false);
        expect(find(c, 'rank_r5').earned).toBe(false);
    });

    it('an R4 player earns R1 through R4 and locks R5 with progress', () => {
        const c = compute({ role: 'R4', created_at: null, overall_power: 0, attended: 0 });
        expect(find(c, 'rank_r1').earned).toBe(true);
        expect(find(c, 'rank_r4').earned).toBe(true);
        expect(find(c, 'rank_r5').earned).toBe(false);
        expect(find(c, 'rank_r5').progress).toBe(80);
        expect(find(c, 'rank_r5').current).toBe(4);
        expect(find(c, 'rank_r5').target).toBe(5);
    });

    it('treats a missing role as R1', () => {
        const c = compute({ role: null, created_at: null, overall_power: 0, attended: 0 });
        expect(find(c, 'rank_r1').earned).toBe(true);
        expect(find(c, 'rank_r2').earned).toBe(false);
    });
});

describe('GM_BADGES seniority badges', () => {
    it('a brand new member earns no seniority badge', () => {
        const c = compute({ role: 'R1', created_at: new Date().toISOString(), overall_power: 0, attended: 0 });
        expect(find(c, 'tenure_1m').earned).toBe(false);
        expect(find(c, 'tenure_2y').earned).toBe(false);
    });

    it('a 60-day member earns 1m and 2m badges, partial on 3-month', () => {
        const past = new Date(Date.now() - 60 * 86400000).toISOString();
        const c = compute({ role: 'R1', created_at: past, overall_power: 0, attended: 0 });
        expect(find(c, 'tenure_1m').earned).toBe(true);
        expect(find(c, 'tenure_2m').earned).toBe(true);
        expect(find(c, 'tenure_3m').earned).toBe(false);
        expect(find(c, 'tenure_3m').progress).toBe(67);
    });

    it('a 400-day member earns up to 1-year and locks 2-year at 54%', () => {
        const past = new Date(Date.now() - 400 * 86400000).toISOString();
        const c = compute({ role: 'R1', created_at: past, overall_power: 0, attended: 0 });
        expect(find(c, 'tenure_1y').earned).toBe(true);
        expect(find(c, 'tenure_2y').earned).toBe(false);
        expect(find(c, 'tenure_2y').progress).toBe(55);
    });

    it('ignores an invalid date string', () => {
        const c = compute({ role: 'R1', created_at: 'not-a-date', overall_power: 0, attended: 0 });
        expect(find(c, 'tenure_1m').earned).toBe(false);
        expect(find(c, 'tenure_1m').current).toBe(0);
    });
});

describe('GM_BADGES power badges', () => {
    it('locks everything at zero power', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 0 });
        expect(find(c, 'power_10m').earned).toBe(false);
        expect(find(c, 'power_300m').earned).toBe(false);
    });

    it('75M power earns Fighter, Brawler, Warrior and Elite, Titan at 75%', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 75000000, attended: 0 });
        expect(find(c, 'power_10m').earned).toBe(true);
        expect(find(c, 'power_25m').earned).toBe(true);
        expect(find(c, 'power_50m').earned).toBe(true);
        expect(find(c, 'power_75m').earned).toBe(true);
        expect(find(c, 'power_100m').earned).toBe(false);
        expect(find(c, 'power_100m').progress).toBe(75);
        expect(find(c, 'power_100m').current).toBe(75000000);
    });

    it('300M power unlocks every power badge', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 300000000, attended: 0 });
        expect(find(c, 'power_300m').earned).toBe(true);
        expect(find(c, 'power_300m').progress).toBe(100);
    });

    it('keeps the max tier at 300M (no higher tier exists)', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 9000000000, attended: 0 });
        expect(find(c, 'power_300m').earned).toBe(true);
        const powerBadges = c.categories.find((cat) => cat.id === 'power').badges;
        const maxTarget = Math.max.apply(null, powerBadges.map((b) => b.target));
        expect(maxTarget).toBe(300000000);
    });
});

describe('GM_BADGES participation badges', () => {
    it('12 attended events unlock Active only', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 12 });
        expect(find(c, 'part_10').earned).toBe(true);
        expect(find(c, 'part_25').earned).toBe(false);
        expect(find(c, 'part_25').progress).toBe(48);
    });

    it('100 attended events unlock through Iron Will, Vanguard still locked', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 100 });
        expect(find(c, 'part_100').earned).toBe(true);
        expect(find(c, 'part_200').earned).toBe(false);
    });

    it('1500 attended events unlock every participation badge', () => {
        const c = compute({ role: 'R1', created_at: null, overall_power: 0, attended: 1500 });
        expect(find(c, 'part_1000').earned).toBe(true);
        expect(find(c, 'part_1500').earned).toBe(true);
    });

    it('treats string numbers and null attended values safely', () => {
        const c = compute({ role: 'R3', created_at: null, overall_power: '50000000', attended: null });
        expect(find(c, 'power_50m').earned).toBe(true);
        expect(find(c, 'part_10').earned).toBe(false);
    });
});

describe('GM_BADGES helper functions', () => {
    it('parses rank strings', () => {
        expect(window.GM_BADGES.parseRank('R3')).toBe(3);
        expect(window.GM_BADGES.parseRank('r5')).toBe(5);
        expect(window.GM_BADGES.parseRank(null)).toBe(1);
        expect(window.GM_BADGES.parseRank('guildmaster')).toBe(1);
    });

    it('computes days since a date', () => {
        const past = new Date(Date.now() - 10 * 86400000).toISOString();
        expect(window.GM_BADGES.daysSince(past)).toBe(10);
        expect(window.GM_BADGES.daysSince(null)).toBe(0);
    });
});
