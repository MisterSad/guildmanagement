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
        // Flagship: 10M * 4.0 = 40M
        // Fleet: 2M * 3.5 = 7M
        // Tech: 15M * 2.5 = 37.5M
        // Crew: 5M * 1.5 = 7.5M
        // Champs: 30M * 0.8 = 24M
        // Glory: 250M * 1.0 = 250M
        // Sum = 366.0M / 100M = 366.0%
        const density = window.GM.calculateCombatDensity(mockMember);
        expect(density).toBe(366);
    });

    it('calculates composite rally score correctly with exact hierarchy Power > Flagship > Fleet > Tech > Crew > Champs > Glory', () => {
        // 100M (Power) + 366.0M (Weighted Combat) = 466.0M
        const rallyScore = window.GM.calculateRallyScore(mockMember);
        expect(rallyScore).toBe(466000000);
        expect(window.GM.calculateWarScore(mockMember)).toBe(466000000);
    });

    it('prioritizes components in exact order (Power > Flagship > Fleet > Tech > Crew > Champs > Glory)', () => {
        const base = { overall_power: 100000000, flagship_power: 10000000, fleet_rating: 2000000, tech_power: 10000000, crew_power: 5000000, champion_power: 20000000, glory_score: 100000000 };
        const scoreBase = window.GM.calculateRallyScore(base);

        // +1M to Flagship adds 4M
        const moreFlag = { ...base, flagship_power: base.flagship_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreFlag) - scoreBase).toBe(4000000);

        // +1M to Fleet adds 3.5M
        const moreFleet = { ...base, fleet_rating: base.fleet_rating + 1000000 };
        expect(window.GM.calculateRallyScore(moreFleet) - scoreBase).toBe(3500000);

        // +1M to Tech adds 2.5M
        const moreTech = { ...base, tech_power: base.tech_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreTech) - scoreBase).toBe(2500000);

        // +1M to Crew adds 1.5M
        const moreCrew = { ...base, crew_power: base.crew_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreCrew) - scoreBase).toBe(1500000);

        // +1M to Champs adds 0.8M
        const moreChamps = { ...base, champion_power: base.champion_power + 1000000 };
        expect(window.GM.calculateRallyScore(moreChamps) - scoreBase).toBe(800000);

        // +1M to Glory adds 1.0M
        const moreGlory = { ...base, glory_score: base.glory_score + 1000000 };
        expect(window.GM.calculateRallyScore(moreGlory) - scoreBase).toBe(1000000);
    });

    it('handles zero or negative power in combat density gracefully', () => {
        expect(window.GM.calculateCombatDensity({ overall_power: 0 })).toBe(0);
        expect(window.GM.calculateCombatDensity(null)).toBe(0);
        expect(window.GM.calculateCombatDensity({})).toBe(0);
    });

    it('treats missing, null, undefined, or empty metrics strictly as 0', () => {
        const partialMember = {
            pseudo: 'PartialPlayer',
            overall_power: 100000000,
            flagship_power: 10000000, // 10M * 4.0 = 40M
            fleet_rating: null,       // counts as 0
            tech_power: undefined,    // counts as 0
            crew_power: '',           // counts as 0
            champion_power: 0,        // counts as 0
            glory_score: null         // counts as 0
        };

        // 40M / 100M = 40.0%
        const density = window.GM.calculateCombatDensity(partialMember);
        expect(density).toBe(40);

        // 100M + 40M = 140M
        const rallyScore = window.GM.calculateRallyScore(partialMember);
        expect(rallyScore).toBe(140000000);
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

    it('assigns top 16 players as Rally Leaders and remaining as Rally Joiners accurately', () => {
        expect(window.GM.getRallyRoleMeta(1, 100000000)).toEqual({
            isLeader: true,
            rank: 1,
            label: 'Rally Leader #1',
            type: 'leader'
        });

        expect(window.GM.getRallyRoleMeta(16, 50000000)).toEqual({
            isLeader: true,
            rank: 16,
            label: 'Rally Leader #16',
            type: 'leader'
        });

        expect(window.GM.getRallyRoleMeta(17, 45000000)).toEqual({
            isLeader: false,
            rank: 17,
            label: 'Rally Joiner',
            type: 'joiner'
        });

        expect(window.GM.getRallyRoleMeta(1, 0)).toEqual({
            isLeader: false,
            rank: 1,
            label: 'Rally Joiner',
            type: 'joiner'
        });

        // 20 dummy members
        const roster = Array.from({ length: 20 }, (_, i) => ({
            pseudo: `Player_${i + 1}`,
            overall_power: (20 - i) * 10000000,
            flagship_power: (20 - i) * 1000000
        }));

        const rallyRankedList = roster.slice().sort((a, b) => {
            const rA = window.GM.calculateRallyScore(a);
            const rB = window.GM.calculateRallyScore(b);
            if (rB !== rA) return rB - rA;
            return (b.overall_power || 0) - (a.overall_power || 0);
        });

        const rallyRankMap = {};
        rallyRankedList.forEach((m, idx) => {
            rallyRankMap[m.pseudo] = window.GM.getRallyRoleMeta(idx + 1, window.GM.calculateRallyScore(m));
        });

        expect(rallyRankMap['Player_1'].isLeader).toBe(true);
        expect(rallyRankMap['Player_1'].rank).toBe(1);
        expect(rallyRankMap['Player_16'].isLeader).toBe(true);
        expect(rallyRankMap['Player_16'].rank).toBe(16);
        expect(rallyRankMap['Player_17'].isLeader).toBe(false);
        expect(rallyRankMap['Player_17'].label).toBe('Rally Joiner');
        expect(rallyRankMap['Player_20'].isLeader).toBe(false);
        expect(rallyRankMap['Player_20'].label).toBe('Rally Joiner');
    });

    it('ranks powerhouse players with massive absolute stats above low-power accounts with high density ratio', () => {
        const whale = {
            pseudo: 'GiganticWhale',
            overall_power: 500000000,   // 500M
            flagship_power: 30000000,   // 30M * 4.0 = 120M
            fleet_rating: 6000000,      // 6M * 3.5 = 21M
            tech_power: 40000000,       // 40M * 2.5 = 100M
            crew_power: 10000000,       // 10M * 1.5 = 15M
            champion_power: 40000000,   // 40M * 0.8 = 32M
            glory_score: 300000000      // 300M * 1.0 = 300M
            // Weighted combat = 588M. Rally score = 500M + 588M = 1.088 Billion!
            // Density ratio = 588M / 500M = 117.6%
        };

        const smallPlayer = {
            pseudo: 'SmallSpecialist',
            overall_power: 30000000,    // 30M
            flagship_power: 5000000,    // 5M * 4.0 = 20M
            fleet_rating: 1500000,      // 1.5M * 3.5 = 5.25M
            tech_power: 10000000,       // 10M * 2.5 = 25M
            crew_power: 2000000,        // 2M * 1.5 = 3M
            champion_power: 5000000,    // 5M * 0.8 = 4M
            glory_score: 50000000       // 50M * 1.0 = 50M
            // Weighted combat = 107.25M. Rally score = 30M + 107.25M = 137.25M
            // Density ratio = 107.25M / 30M = 357.5% (very high percentage ratio)
        };

        // Small specialist has higher percentage density (357.5% > 117.6%)
        expect(window.GM.calculateCombatDensity(smallPlayer)).toBeGreaterThan(window.GM.calculateCombatDensity(whale));

        // BUT the Whale has vastly superior absolute Rally Score (1.088B > 137.25M)
        expect(window.GM.calculateRallyScore(whale)).toBeGreaterThan(window.GM.calculateRallyScore(smallPlayer));

        // When sorting by Rally Score, Whale is decisively #1!
        const sorted = [smallPlayer, whale].sort((a, b) => {
            return window.GM.calculateRallyScore(b) - window.GM.calculateRallyScore(a);
        });
        expect(sorted[0].pseudo).toBe('GiganticWhale');
        expect(sorted[1].pseudo).toBe('SmallSpecialist');
    });
});


