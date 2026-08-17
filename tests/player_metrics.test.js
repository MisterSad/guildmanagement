/**
 * tests/player_metrics.test.js
 *
 * Unit tests for 7-score tactical military metrics, KPI calculations,
 * and sorting algorithms.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import '../gm-utils.js';
import { PortalService } from '../src/modules/portal/portal.service.ts';

describe('Tactical Military Metrics & Calculations', () => {
    const mockMember = {
        pseudo: 'Kelisco',
        guild: 'ALPHA',
        overall_power: 100000000,
        tech_power: 15000000,
        champion_power: 30000000,
        crew_power: 5000000,
        flagship_power: 10000000,
        fleet_rating: 2000000,
        glory_score: 250000000
    };

    it('calculates weighted combat density according to tactical hierarchy', () => {
        // Flagship: 10M * 3.0 = 30M
        // Fleet: 2M * 2.5 = 5M
        // Tech: 15M * 2.0 = 30M
        // Crew: 5M * 1.5 = 7.5M
        // Champs: 30M * 0.4 = 12M
        // Glory: 250M * 0.03 = 7.5M
        // Sum = 92M / 100M = 92.0%
        const density = window.GM.calculateCombatDensity(mockMember);
        expect(density).toBe(92);
    });

    it('calculates composite rally score correctly with exact hierarchy Power > Flagship > Fleet > Tech > Crew > Champs > Glory', () => {
        // 100M (Power) + 92.0M (Weighted Combat) = 192.0M
        const rallyScore = window.GM.calculateRallyScore(mockMember);
        expect(rallyScore).toBe(192000000);
        expect(window.GM.calculateWarScore(mockMember)).toBe(192000000);
    });

    it('prioritizes components in exact order (Power > Flagship > Fleet > Tech > Crew > Champs > Glory)', () => {
        const base = { overall_power: 100000000, flagship_power: 10000000, fleet_rating: 2000000, tech_power: 10000000, crew_power: 5000000, champion_power: 20000000, glory_score: 100000000 };
        const scoreBase = window.GM.calculateRallyScore(base);

        // +1M to Flagship adds 3M
        const moreFlag = { ...base, flagship_power: base.flagship_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreFlag) - scoreBase).toBe(3000000);

        // +1M to Fleet adds 2.5M
        const moreFleet = { ...base, fleet_rating: base.fleet_rating + 1000000 };
        expect(window.GM.calculateRallyScore(moreFleet) - scoreBase).toBe(2500000);

        // +1M to Tech adds 2.0M
        const moreTech = { ...base, tech_power: base.tech_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreTech) - scoreBase).toBe(2000000);

        // +1M to Crew adds 1.5M
        const moreCrew = { ...base, crew_power: base.crew_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreCrew) - scoreBase).toBe(1500000);

        // +1M to Champs adds 0.4M
        const moreChamps = { ...base, champion_power: base.champion_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreChamps) - scoreBase).toBe(400000);

        // +1M to Glory adds 0.03M (30k)
        const moreGlory = { ...base, glory_score: base.glory_score + 1000000 };
        expect(window.GM.calculateRallyScore(moreGlory) - scoreBase).toBe(30000);
    });

    it('handles zero or negative power in combat density gracefully', () => {
        expect(window.GM.calculateCombatDensity({ overall_power: 0 })).toBe(0);
        expect(window.GM.calculateCombatDensity(null)).toBe(0);
        expect(window.GM.calculateCombatDensity({})).toBe(0);
    });

    it('calculates residual volatile troop power correctly', () => {
        // 100M - (15M + 30M + 5M) = 50M
        const residual = window.GM.calculateResidualPower(mockMember);
        expect(residual).toBe(50000000);
    });

    it('clamps residual volatile troop power at 0', () => {
        const overInvested = {
            overall_power: 10000000,
            tech_power: 15000000,
            champion_power: 10000000,
            crew_power: 5000000
        };
        expect(window.GM.calculateResidualPower(overInvested)).toBe(0);
    });

    it('calculates combativity ratio (glory to power) correctly', () => {
        // 250M / 100M = 2.5
        const combativity = window.GM.calculateCombativity(mockMember);
        expect(combativity).toBe(2.5);
    });

    it('sorts members accurately by fleet rating', () => {
        const members = [
            { pseudo: 'P1', fleet_rating: 1500000 },
            { pseudo: 'P2', fleet_rating: 2200000 },
            { pseudo: 'P3', fleet_rating: 1800000 }
        ];

        const sorted = members.slice().sort((a, b) => (b.fleet_rating || 0) - (a.fleet_rating || 0));
        expect(sorted[0].pseudo).toBe('P2');
        expect(sorted[1].pseudo).toBe('P3');
        expect(sorted[2].pseudo).toBe('P1');
    });

    it('sorts members accurately by combat density', () => {
        const members = [
            { pseudo: 'P1', overall_power: 100000000, tech_power: 10000000, champion_power: 10000000, crew_power: 0, flagship_power: 0 }, // 20%
            { pseudo: 'P2', overall_power: 100000000, tech_power: 30000000, champion_power: 30000000, crew_power: 5000000, flagship_power: 5000000 }, // 70%
            { pseudo: 'P3', overall_power: 100000000, tech_power: 20000000, champion_power: 20000000, crew_power: 5000000, flagship_power: 5000000 }  // 50%
        ];

        const sorted = members.slice().sort((a, b) => {
            return window.GM.calculateCombatDensity(b) - window.GM.calculateCombatDensity(a);
        });

        expect(sorted[0].pseudo).toBe('P2');
        expect(sorted[1].pseudo).toBe('P3');
        expect(sorted[2].pseudo).toBe('P1');
    });

    it('exposes updateMetrics and getMetricsHistory on PortalService', () => {
        expect(typeof PortalService.updateMetrics).toBe('function');
        expect(typeof PortalService.getMetricsHistory).toBe('function');
    });

    it('reconciles latest recorded Sunday Glory scores across members accurately', () => {
        const gloryEvents = [
            { pseudo: 'P1', score: 280000000, week_start: '2026-08-10' },
            { pseudo: 'P1', score: 240000000, week_start: '2026-08-03' },
            { pseudo: 'P2', score: 150000000, week_start: '2026-08-10' }
        ];

        const latestGloryMap = {};
        gloryEvents.forEach((r) => {
            const key = r.pseudo.toLowerCase();
            if (latestGloryMap[key] === undefined) {
                latestGloryMap[key] = r.score;
            }
        });

        expect(latestGloryMap['p1']).toBe(280000000);
        expect(latestGloryMap['p2']).toBe(150000000);

        const rawMembers = [
            { pseudo: 'P1', glory_score: 0 },
            { pseudo: 'P2', glory_score: null },
            { pseudo: 'P3', glory_score: 50000000 }
        ];

        const reconciled = rawMembers.map((m) => {
            const lastGlory = latestGloryMap[m.pseudo.toLowerCase()];
            if (lastGlory !== undefined && lastGlory > 0) {
                m.glory_score = lastGlory;
            }
            return m;
        });

        expect(reconciled[0].glory_score).toBe(280000000);
        expect(reconciled[1].glory_score).toBe(150000000);
        expect(reconciled[2].glory_score).toBe(50000000);

        const totalGlory = reconciled.reduce((sum, m) => sum + (m.glory_score || 0), 0);
        expect(totalGlory).toBe(480000000);
    });
});

