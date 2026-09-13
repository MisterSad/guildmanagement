/**
 * tests/badges_service.test.js
 *
 * Golden suite for src/modules/badges/badges.service.ts (post badges.js
 * cutover), pinning the 45-badge catalog and representative computations.
 */
import { describe, it, expect } from 'vitest';
import {
  computeBadges,
  parseRank,
  daysSince,
  CATALOG,
  CATEGORIES
} from '../src/modules/badges/badges.service';

describe('BadgesService catalog', () => {
  it('keeps the exact 45-badge / 5-category catalog', () => {
    expect(CATALOG).toHaveLength(45);
    expect(CATEGORIES).toHaveLength(5);
    const result = computeBadges({ role: 'R1', created_at: null, overall_power: 0, attended: 0 });
    expect(result.total).toBe(45);
    expect(result.categories).toHaveLength(5);
    expect(result.categories.map((c) => c.id)).toEqual(['rank', 'tenure', 'power', 'part', 'glory']);
  });

  it('exposes parseRank and daysSince helpers', () => {
    expect(parseRank('R4')).toBe(4);
    expect(parseRank('R1')).toBe(1);
    expect(parseRank('guild_admin')).toBe(1);
    expect(daysSince(null)).toBe(0);
    expect(daysSince('not-a-date')).toBe(0);
  });

  it('handles empty/null input without throwing', () => {
    const c = computeBadges(null);
    expect(c.total).toBe(45);
    expect(c.categories).toHaveLength(5);
  });
});

describe('BadgesService golden computations', () => {
  it('earns every badge for a maxed R5 veteran', () => {
    const c = computeBadges({
      role: 'R5',
      created_at: '2024-01-01T00:00:00Z',
      overall_power: 312000000,
      attended: 1600,
      glory_best: 60000000
    });
    expect(c.earned).toBe(45);
    expect(c.total).toBe(45);
  });

  it('earns a partial set for a mid-game R3 with no join date', () => {
    const c = computeBadges({
      role: 'R3',
      created_at: null,
      overall_power: 80000000,
      attended: 42,
      glory_best: 6000
    });
    // rank R1-R3 (3) + tenure 0 + power 10/25/50/75M (4) + part 10/25 (2) + glory 1K (1)
    expect(c.earned).toBe(10);
    expect(c.total).toBe(45);
  });
});
