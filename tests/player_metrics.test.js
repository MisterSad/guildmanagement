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

    it('calculates combat density ratio correctly', () => {
        // (15M + 30M + 5M + 10M) / 100M = 60M / 100M = 60.0%
        const density = window.GM.calculateCombatDensity(mockMember);
        expect(density).toBe(60);
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

    it('calculates composite war score correctly', () => {
        // (2M * 10) + 10M + (15M * 0.5) + (30M * 0.3) + (250M * 0.05)
        // = 20M + 10M + 7.5M + 9M + 12.5M = 59M
        const warScore = window.GM.calculateWarScore(mockMember);
        expect(warScore).toBe(59000000);
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
});
