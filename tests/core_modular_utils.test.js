/**
 * tests/core_modular_utils.test.js
 *
 * Dedicated unit test battery for modular TypeScript core utilities:
 * - src/core/scoring/combat.ts
 * - src/core/utils/date.ts
 * - src/core/utils/text.ts
 *
 * Verifies strict typing, mathematical invariants, boundary conditions,
 * and seamless parity with window.GM bridge.
 */

import { describe, it, expect } from 'vitest';

// 1. Direct ES module imports
import {
  parseSafeMetric,
  calculateCombatDensity,
  calculateRallyScore,
  calculateRallyGrade,
  calculateResidualPower,
  calculateCombativity,
  calculateWarScore,
  getRallyRoleMeta,
  getPowerTier,
  getPowerTierMeta,
  COMBAT_WEIGHTS
} from '../src/core/scoring/combat';

import {
  pad2,
  getWeekStart,
  getPrevWeekStart,
  formatWeek,
  newSessionId,
  formatChartDate
} from '../src/core/utils/date';

import {
  formatNumber,
  parseNumber,
  formatPower,
  avatarInit,
  cleanPlayerPseudo,
  levenshteinDistance,
  calculateStringSimilarity,
  findBestMatchingMember,
  parseGeminiJson,
  MAX_NUMERIC
} from '../src/core/utils/text';

// 2. Initialize application bridge
import '../src/main';

describe('src/core/scoring/combat.ts', () => {
  const sampleMember = {
    pseudo: 'Vanguard',
    overall_power: 100_000_000,
    fleet_rating: 2_000_000,
    flagship_power: 10_000_000,
    crew_power: 5_000_000,
    tech_power: 15_000_000,
    champion_power: 30_000_000,
    glory_score: 250_000_000
  };

  describe('parseSafeMetric', () => {
    it('handles numeric and formatted string inputs safely', () => {
      expect(parseSafeMetric(12345)).toBe(12345);
      expect(parseSafeMetric('12,345,678')).toBe(12345678);
      expect(parseSafeMetric('  9876.5  ')).toBe(9876.5);
    });

    it('returns 0 for negative, null, undefined, empty, or NaN inputs', () => {
      expect(parseSafeMetric(null)).toBe(0);
      expect(parseSafeMetric(undefined)).toBe(0);
      expect(parseSafeMetric('')).toBe(0);
      expect(parseSafeMetric('invalid')).toBe(0);
      expect(parseSafeMetric(-500)).toBe(0);
      expect(parseSafeMetric(NaN)).toBe(0);
    });
  });

  describe('calculateCombatDensity', () => {
    it('computes weighted combat density accurately', () => {
      // Fleet: 2M * 80.0 = 160M
      // Flagship: 10M * 18.0 = 180M
      // Crew: 5M * 8.0 = 40M
      // Tech: 15M * 6.0 = 90M
      // Champs: 30M * 0.8 = 24M
      // Glory: 250M * 0.05 = 12.5M
      // Sum = 506.5M / 100M = 506.5%
      const density = calculateCombatDensity(sampleMember);
      expect(density).toBe(506.5);
    });

    it('returns 0 if member is missing or total power is zero', () => {
      expect(calculateCombatDensity(null)).toBe(0);
      expect(calculateCombatDensity({ overall_power: 0 })).toBe(0);
      expect(calculateCombatDensity({ overall_power: -100 })).toBe(0);
    });
  });

  describe('calculateRallyScore & calculateWarScore', () => {
    it('computes composite score: total power + weighted combat components', () => {
      // 100M + 506.5M = 606.5M
      const rally = calculateRallyScore(sampleMember);
      expect(rally).toBe(606500000);
      expect(calculateWarScore(sampleMember)).toBe(606500000);
    });

    it('returns 0 for empty or null member', () => {
      expect(calculateRallyScore(null)).toBe(0);
      expect(calculateWarScore(null)).toBe(0);
    });
  });

  describe('calculateRallyGrade', () => {
    it('computes percentage of maxScore bounded between 0 and 100', () => {
      expect(calculateRallyGrade(sampleMember, 606500000)).toBe(100);
      expect(calculateRallyGrade(sampleMember, 1213000000)).toBe(50);
      expect(calculateRallyGrade(sampleMember, 300000000)).toBe(100); // capped at 100
      expect(calculateRallyGrade(null, 1000)).toBe(0);
      expect(calculateRallyGrade(sampleMember, 0)).toBe(100);
    });
  });

  describe('calculateResidualPower', () => {
    it('computes power remaining after deducting tech, champions, and crew', () => {
      // 100M - (15M tech + 30M champ + 5M crew) = 50M
      expect(calculateResidualPower(sampleMember)).toBe(50000000);
      expect(calculateResidualPower(null)).toBe(0);
    });
  });

  describe('calculateCombativity', () => {
    it('computes glory to power ratio rounded to two decimals', () => {
      // 250M / 100M = 2.5
      expect(calculateCombativity(sampleMember)).toBe(2.5);
      expect(calculateCombativity(null)).toBe(0);
      expect(calculateCombativity({ overall_power: 0 })).toBe(0);
    });
  });

  describe('getRallyRoleMeta', () => {
    it('identifies Rally Leader for rank <= 16 with positive score', () => {
      const leader = getRallyRoleMeta(1, 500000);
      expect(leader).toEqual({ isLeader: true, rank: 1, label: 'Rally Leader #1', type: 'leader' });
      const rank16 = getRallyRoleMeta(16, 500000);
      expect(rank16.isLeader).toBe(true);
    });

    it('identifies Rally Joiner for rank > 16 or score <= 0', () => {
      expect(getRallyRoleMeta(17, 500000)).toEqual({ isLeader: false, rank: 17, label: 'Rally Joiner', type: 'joiner' });
      expect(getRallyRoleMeta(1, 0)).toEqual({ isLeader: false, rank: 1, label: 'Rally Joiner', type: 'joiner' });
    });
  });

  describe('getPowerTier & getPowerTierMeta', () => {
    it('assigns power tier based on fraction of maxPower', () => {
      expect(getPowerTier(85, 100)).toBe('S');
      expect(getPowerTier(65, 100)).toBe('A');
      expect(getPowerTier(45, 100)).toBe('B');
      expect(getPowerTier(25, 100)).toBe('C');
      expect(getPowerTier(10, 100)).toBe('D');
      expect(getPowerTier(0, 100)).toBe('D');
      expect(getPowerTier(50, 0)).toBe('D');
    });

    it('provides correct styling and label metadata per tier', () => {
      expect(getPowerTierMeta('S')).toEqual({ cls: 'tier-s', label: 'Mythic', color: 'var(--accent)', icon: '👑' });
      expect(getPowerTierMeta('A')).toEqual({ cls: 'tier-a', label: 'Legendary', color: '#ef4444', icon: '🔥' });
      expect(getPowerTierMeta('B')).toEqual({ cls: 'tier-b', label: 'Epic', color: '#f97316', icon: '💎' });
      expect(getPowerTierMeta('C')).toEqual({ cls: 'tier-c', label: 'Rare', color: '#3b82f6', icon: '⭐' });
      expect(getPowerTierMeta('D')).toEqual({ cls: 'tier-d', label: 'Common', color: 'var(--text-muted)', icon: '🛡️' });
    });
  });
});

describe('src/core/utils/date.ts', () => {
  describe('pad2', () => {
    it('pads single digit numbers and strings with leading zero', () => {
      expect(pad2(5)).toBe('05');
      expect(pad2('9')).toBe('09');
      expect(pad2(12)).toBe('12');
    });
  });

  describe('getWeekStart & getPrevWeekStart', () => {
    it('computes Monday UTC correctly', () => {
      // 2026-09-05 is a Saturday. Monday was 2026-08-31
      const monday = getWeekStart('2026-09-05T12:00:00Z');
      expect(monday).toBe('2026-08-31');

      const prevMonday = getPrevWeekStart(monday);
      expect(prevMonday).toBe('2026-08-24');
    });
  });

  describe('formatWeek', () => {
    it('formats Monday date into standard 7-day range string', () => {
      const formatted = formatWeek('2026-08-31');
      expect(formatted).toBe('31/08 → 06/09/2026');
      expect(formatWeek('')).toBe('');
    });
  });

  describe('newSessionId', () => {
    it('generates an ISO timestamp string', () => {
      const sid = newSessionId();
      expect(typeof sid).toBe('string');
      expect(new Date(sid).getTime()).not.toBeNaN();
    });
  });

  describe('formatChartDate', () => {
    it('formats YYYY-MM-DD to DD/MM/YY', () => {
      expect(formatChartDate('2026-08-15')).toBe('15/08/26');
      expect(formatChartDate({ week_start: '2026-08-15' })).toBe('15/08/26');
    });

    it('formats compact YYYYMMDD IDs like SF-20260815 to DD/MM/YY', () => {
      expect(formatChartDate('ARA-20260815')).toBe('15/08/26');
    });

    it('formats ISO week keys like SVS-2026-W33', () => {
      const formatted = formatChartDate('SVS-2026-W33');
      expect(formatted).toMatch(/^\d{2}\/\d{2}\/26$/);
    });

    it('returns empty string on empty input', () => {
      expect(formatChartDate(null)).toBe('');
      expect(formatChartDate('')).toBe('');
    });
  });
});

describe('src/core/utils/text.ts', () => {
  describe('formatNumber & parseNumber', () => {
    it('formats numbers with spaces as thousands separators', () => {
      expect(formatNumber(1000000)).toBe('1 000 000');
      expect(formatNumber('25000000')).toBe('25 000 000');
      expect(formatNumber(0)).toBe('0');
      expect(formatNumber(null)).toBe('');
      expect(formatNumber(15000000000)).toBe('9 999 999 999'); // Clamped to MAX_NUMERIC
    });

    it('parses numbers from formatted strings and clamps to MAX_NUMERIC', () => {
      expect(parseNumber('1 000 000')).toBe(1000000);
      expect(parseNumber('42M')).toBe(42);
      expect(parseNumber('')).toBeNull();
      expect(parseNumber(null)).toBeNull();
      expect(parseNumber('999999999999')).toBe(MAX_NUMERIC);
    });
  });

  describe('formatPower', () => {
    it('formats power values with B, M, and K suffixes', () => {
      expect(formatPower(1500000000)).toBe('1.5B');
      expect(formatPower(24000000)).toBe('24.0M');
      expect(formatPower(350000)).toBe('350.0K');
      expect(formatPower(500)).toBe('500');
      expect(formatPower(null)).toBe('-');
    });
  });

  describe('avatarInit', () => {
    it('extracts camelCase and spaced initials', () => {
      expect(avatarInit('HawkTuah')).toBe('HT');
      expect(avatarInit('StarWarrior99')).toBe('SW');
      expect(avatarInit('John Doe')).toBe('JD');
      expect(avatarInit('single')).toBe('SI');
      expect(avatarInit('')).toBe('?');
    });
  });

  describe('cleanPlayerPseudo', () => {
    it('strips bracketed tags and prefixes cleanly', () => {
      expect(cleanPlayerPseudo('[ALPHA] Commander', '[ALPHA]')).toBe('Commander');
      expect(cleanPlayerPseudo('[ALPHA]-Warrior', 'ALPHA')).toBe('Warrior');
      expect(cleanPlayerPseudo('[CLAW] Shadow', null)).toBe('Shadow');
      expect(cleanPlayerPseudo('RegularHero', 'BABE')).toBe('RegularHero');
      expect(cleanPlayerPseudo('')).toBe('');
    });
  });

  describe('levenshteinDistance & calculateStringSimilarity', () => {
    it('calculates correct Levenshtein distance', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
      expect(levenshteinDistance('alpha', 'alpha')).toBe(0);
      expect(levenshteinDistance('', 'test')).toBe(4);
    });

    it('calculates string similarity ratio', () => {
      expect(calculateStringSimilarity('Kelisco', 'Kelisco')).toBe(1.0);
      expect(calculateStringSimilarity('[ALPHA] Kelisco', 'Kelisco')).toBe(0.95);
      expect(calculateStringSimilarity('abc', 'xyz')).toBeLessThan(0.4);
    });
  });

  describe('findBestMatchingMember', () => {
    const roster = [
      { pseudo: 'Kelisco', role: 'R4' },
      { pseudo: 'Vanguard', role: 'R3' },
      { pseudo: 'Shadow-Sniper', role: 'R2' }
    ];

    it('matches exact pseudos with score 1.0', () => {
      const match = findBestMatchingMember('kelisco', roster);
      expect(match).not.toBeNull();
      expect(match?.member.pseudo).toBe('Kelisco');
      expect(match?.matchType).toBe('exact');
      expect(match?.score).toBe(1.0);
    });

    it('matches clean tag with score 0.98', () => {
      const match = findBestMatchingMember('[ALPHA] Kelisco', roster, '[ALPHA]');
      expect(match).not.toBeNull();
      expect(match?.member.pseudo).toBe('Kelisco');
      expect(match?.matchType).toBe('clean_tag');
    });

    it('matches fuzzy pseudo when similarity exceeds 0.75', () => {
      const match = findBestMatchingMember('Vanguar', roster);
      expect(match).not.toBeNull();
      expect(match?.member.pseudo).toBe('Vanguard');
      expect(match?.matchType).toBe('fuzzy');
      expect(match?.score).toBeGreaterThanOrEqual(0.75);
    });

    it('returns null when no matching member meets threshold', () => {
      expect(findBestMatchingMember('CompletelyDifferent', roster)).toBeNull();
      expect(findBestMatchingMember(null, roster)).toBeNull();
    });
  });

  describe('parseGeminiJson', () => {
    it('parses markdown-fenced JSON and extracts embedded substring', () => {
      const fenced = '```json\n{"status":"ok","count":42}\n```';
      expect(parseGeminiJson(fenced)).toEqual({ status: 'ok', count: 42 });

      const embedded = 'Analysis report:\n```\n[1, 2, 3]\n```\nDone.';
      expect(parseGeminiJson(embedded)).toEqual([1, 2, 3]);

      expect(parseGeminiJson(null)).toBeNull();
      expect(() => parseGeminiJson('bad json')).toThrow();
    });
  });
});

describe('window.GM bridge parity', () => {
  it('exposes identical scoring, date, and text utilities on window.GM', () => {
    const GM = window.GM;
    expect(GM).toBeDefined();

    // Scoring functions
    expect(typeof GM.calculateCombatDensity).toBe('function');
    expect(typeof GM.calculateRallyScore).toBe('function');
    expect(typeof GM.calculateRallyGrade).toBe('function');
    expect(typeof GM.calculateResidualPower).toBe('function');
    expect(typeof GM.calculateCombativity).toBe('function');
    expect(typeof GM.calculateWarScore).toBe('function');
    expect(typeof GM.getRallyRoleMeta).toBe('function');
    expect(typeof GM.getPowerTier).toBe('function');
    expect(typeof GM.getPowerTierMeta).toBe('function');

    // Date functions
    expect(typeof GM.pad2).toBe('function');
    expect(typeof GM.getWeekStart).toBe('function');
    expect(typeof GM.getPrevWeekStart).toBe('function');
    expect(typeof GM.formatWeek).toBe('function');
    expect(typeof GM.newSessionId).toBe('function');
    expect(typeof GM.formatChartDate).toBe('function');

    // Text functions
    expect(typeof GM.formatNumber).toBe('function');
    expect(typeof GM.parseNumber).toBe('function');
    expect(typeof GM.formatPower).toBe('function');
    expect(typeof GM.avatarInit).toBe('function');
    expect(typeof GM.cleanPlayerPseudo).toBe('function');
    expect(typeof GM.levenshteinDistance).toBe('function');
    expect(typeof GM.calculateStringSimilarity).toBe('function');
    expect(typeof GM.findBestMatchingMember).toBe('function');
    expect(typeof GM.parseGeminiJson).toBe('function');

    // Mathematical equivalence through window.GM
    const testMember = { overall_power: 100000000, fleet_rating: 2000000 };
    expect(GM.calculateCombatDensity(testMember)).toBe(calculateCombatDensity(testMember));
    expect(GM.calculateRallyScore(testMember)).toBe(calculateRallyScore(testMember));
    expect(GM.formatNumber(1234567)).toBe(formatNumber(1234567));
    expect(GM.getWeekStart('2026-09-05')).toBe(getWeekStart('2026-09-05'));
  });
});
