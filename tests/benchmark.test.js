import { describe, it, expect } from 'vitest';
import '../benchmark.js';

const BENCH = window.GM_BENCHMARK;

describe('GM_BENCHMARK alerts', () => {
    it('flags low participation below 40%', () => {
        const alerts = BENCH.alertsFor({ members: 100, participation_rate: 30, inactive_members: 5, max_power: 1000000 });
        expect(alerts).toContain('Low participation');
    });

    it('flags many inactive members over 35% of the roster', () => {
        const alerts = BENCH.alertsFor({ members: 100, participation_rate: 70, inactive_members: 40, max_power: 1000000 });
        expect(alerts).toContain('Many inactive');
    });

    it('flags a guild with no power data', () => {
        const alerts = BENCH.alertsFor({ members: 50, participation_rate: 60, inactive_members: 3, max_power: 0 });
        expect(alerts).toContain('No power data');
    });

    it('returns no alerts for a healthy guild', () => {
        const alerts = BENCH.alertsFor({ members: 100, participation_rate: 75, inactive_members: 10, max_power: 50000000 });
        expect(alerts).toEqual([]);
    });
});
