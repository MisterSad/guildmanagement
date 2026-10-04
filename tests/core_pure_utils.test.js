/**
 * tests/core_pure_utils.test.js
 *
 * Phase 1 (Sous-lot 5.2A) parity suite for the pure helpers ported from
 * gm-utils.js into /src/core. The parity oracle used to be the GM window
 * bridge; since M4c removed it (it only re-exported these same functions),
 * the expected values are pinned literally -- the outputs the bridge and the
 * typed modules both produced when the bridge was deleted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import * as text from '../src/core/utils/text';
import * as date from '../src/core/utils/date';
import * as events from '../src/core/config/events';
import * as combat from '../src/core/scoring/combat';
import * as asyncUtils from '../src/core/utils/async';
import { GVG_DAILY_TASKS } from '../src/core/config/gvg-daily-tasks';
import { patchAppState } from '../src/core/state/app-state';

/** Asserts fn(input) === expected for each [input, expected] pair. */
function expectPairs(fn, pairs) {
  pairs.forEach(([input, expected]) => {
    expect(fn(input)).toBe(expected);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('escapeHTML — strict XSS parity', () => {
  const samples = [
    ['<script>alert("xss")</script>', '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'],
    [`A&B 'quote' "double" \`tick\``, 'A&amp;B &#39;quote&#39; &quot;double&quot; &#96;tick&#96;'],
    ['plain text', 'plain text'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['', '']
  ];
  samples.forEach(([s, expected], i) => {
    it('matches gm-utils for sample #' + i, () => {
      expect(text.escapeHTML(s)).toBe(expected);
    });
  });
});

describe('validation & roles', () => {
  it('validatePseudo matches gm-utils', () => {
    expectPairs(text.validatePseudo, [
      ['OkPseudo', null], ['', 'validation_pseudo_empty'], ['   ', 'validation_pseudo_empty'],
      ['a'.repeat(33), 'validation_pseudo_too_long'], ['<b>', 'validation_pseudo_invalid_chars'],
      ['nice_name-1', null], [null, 'validation_pseudo_invalid'], [42, 'validation_pseudo_invalid']
    ]);
  });

  it('validateUid matches gm-utils', () => {
    expectPairs(text.validateUid, [
      ['', null], [null, null], ['123456', null], ['12345', 'validation_uid_too_short'],
      ['12345678901', 'validation_uid_too_long'], ['abc123', 'validation_uid_not_numeric'],
      ['12345a', 'validation_uid_not_numeric'], ['1234567890', null]
    ]);
  });

  it('normalizeRole matches gm-utils', () => {
    expectPairs(text.normalizeRole, [
      ['R5', 'member'], ['R4', 'member'], ['admin', 'member'], ['server_admin', 'server_admin'],
      ['super_admin', 'super_admin'], ['guild_admin', 'guild_admin'], ['member', 'member'],
      ['x', 'member'], [null, 'member']
    ]);
  });
});

describe('similarity & levenshtein', () => {
  it('levenshteinDistance matches gm-utils', () => {
    [[['kitten', 'sitting'], 3], [['', 'abc'], 3], [['abc', ''], 3], [['same', 'same'], 0], [['[PR1M]Alpha', 'Alpha'], 6]].forEach(([[a, b], expected]) => {
      expect(text.levenshteinDistance(a, b)).toBe(expected);
    });
  });

  it('calculateStringSimilarity matches gm-utils', () => {
    [[['[PR1M]Alpha', 'Alpha'], 0.95], [['StarWarrior99', 'star warrior 99'], 0.95], [['aaaa', 'bbbb'], 0], [['x', 'x'], 1]].forEach(([[a, b], expected]) => {
      expect(text.calculateStringSimilarity(a, b)).toBe(expected);
    });
  });
});

describe('numbers', () => {
  it('parseNumber matches gm-utils', () => {
    expectPairs(text.parseNumber, [
      [null, null], ['', null], ['0', 0], ['12 345', 12345], ['abc', null], [42, 42],
      ['99999999999999', 9999999999]
    ]);
  });

  it('formatNumber matches gm-utils', () => {
    expectPairs(text.formatNumber, [
      [null, ''], ['', ''], [0, '0'], [1000000, '1 000 000'], ['1 234 567', '1 234 567'],
      ['abc', ''], [99999999999999, '9 999 999 999']
    ]);
  });

  it('formatPower matches gm-utils', () => {
    expectPairs(text.formatPower, [
      [null, '-'], ['', '-'], [0, '-'], [999, '999'], [1500, '1.5K'], [2500000, '2.5M'],
      [1500000000, '1.5B']
    ]);
  });

  it('parseSafeMetric handles commas and negatives', () => {
    expect(combat.parseSafeMetric('1,234.5')).toBe(1234.5);
    expect(combat.parseSafeMetric(-5)).toBe(0);
    expect(combat.parseSafeMetric('abc')).toBe(0);
    expect(combat.parseSafeMetric(null)).toBe(0);
  });

  it('getPowerTier / getPowerTierMeta match gm-utils', () => {
    const meta = {
      S: { cls: 'tier-s', label: 'Mythic', color: 'var(--accent)', icon: '👑' },
      A: { cls: 'tier-a', label: 'Legendary', color: '#ef4444', icon: '🔥' },
      B: { cls: 'tier-b', label: 'Epic', color: '#f97316', icon: '💎' },
      D: { cls: 'tier-d', label: 'Common', color: 'var(--text-muted)', icon: '🛡️' }
    };
    [[[50, 100], 'B'], [[80, 100], 'S'], [[65, 100], 'A'], [[45, 100], 'B'], [[10, 100], 'D'], [[0, 0], 'D']].forEach(([[p, m], tier]) => {
      expect(combat.getPowerTier(p, m)).toBe(tier);
      expect(combat.getPowerTierMeta(combat.getPowerTier(p, m))).toEqual(meta[tier]);
    });
  });
});

describe('dates', () => {
  const fixed = [
    // [input, weekStart, prevWeekStart, formatWeek, formatDateTimeUTC]
    ['2026-08-03T10:00:00Z', '2026-08-03', '2026-07-27', '03/08 → 09/08/2026', 'Mon 03/08 · 10:00 UTC'],
    ['2026-01-01T00:00:00Z', '2025-12-29', '2025-12-22', '29/12 → 04/01/2026', 'Thu 01/01 · 00:00 UTC'],
    ['2025-12-31T23:59:00Z', '2025-12-29', '2025-12-22', '29/12 → 04/01/2026', 'Wed 31/12 · 23:59 UTC']
  ];
  it('getWeekStart / getPrevWeekStart / formatWeek match gm-utils', () => {
    fixed.forEach(([d, weekStart, prev, label]) => {
      const ws = date.getWeekStart(d);
      expect(ws).toBe(weekStart);
      expect(date.getPrevWeekStart(ws)).toBe(prev);
      expect(date.formatWeek(ws)).toBe(label);
    });
  });

  it('formatDateTimeUTC matches gm-utils', () => {
    fixed.forEach(([d, , , , formatted]) => {
      expect(date.formatDateTimeUTC(d)).toBe(formatted);
    });
    expect(date.formatDateTimeUTC(null)).toBe('');
  });

  it('pad2 zero-pads', () => {
    expect(date.pad2(0)).toBe('00');
    expect(date.pad2(5)).toBe('05');
    expect(date.pad2(12)).toBe('12');
  });
});

describe('event identity', () => {
  it('buildEventSessionId matches gm-utils (including collision suffixes)', () => {
    const ref = new Date('2026-08-03T00:00:00Z');
    [
      ['SvS', 'SVS-2026-W32', 'SVS-2026-W32'],
      ['GvG', 'GVG-2026-W32', 'GVG-2026-W32'],
      ['Arms Race Stage A', 'ARA-20260803-1', 'ARA-20260803-2'],
      ['Arms Race Stage B', 'ARB-20260803-1', 'ARB-20260803-2'],
      ['Defend Trade Route', 'DTR-20260803-1', 'DTR-20260803-2'],
      ['Shadowfront Squad 1', 'SF1-20260803-1', 'SF1-20260803-2'],
      ['Shadowfront Squad 2', 'SF2-20260803-1', 'SF2-20260803-2']
    ].forEach(([ev, firstId, secondId]) => {
      const ids = [];
      const first = events.buildEventSessionId(ev, ref, ids);
      expect(first).toBe(firstId);
      ids.push(first);
      expect(events.buildEventSessionId(ev, ref, ids)).toBe(secondId);
    });
  });

  it('eventScoringKey matches gm-utils', () => {
    [
      [['SvS', 's1', '2026-08-03'], 'SvS|2026-08-03'],
      [['GvG', 's1', '2026-08-03'], 'GvG|2026-08-03'],
      [['ARMS RACE STAGE A', 'a1', '2026-08-03'], 'Arms Race|a1'],
      [['Shadowfront', 's1', '2026-08-03'], 'Shadowfront|2026-08-03'],
      [['Defend Trade Route', 'd1', '2026-08-03'], 'DTR|d1']
    ].forEach(([[ev, sid, ws], expected]) => {
      expect(events.eventScoringKey(ev, sid, ws)).toBe(expected);
    });
  });

  it('sessionDateFromId matches gm-utils', () => {
    [['ARA-20260815-1', '2026-08-15T00:00:00.000Z'], ['SVS-2026-W32', null], ['nope', null]].forEach(([sid, expected]) => {
      const a = events.sessionDateFromId(sid);
      expect(a ? a.toISOString() : null).toBe(expected);
    });
  });

  it('getEventIcon / getEventTheme / computeShadowfrontAttendanceRate match gm-utils', () => {
    [
      ['SvS', 'ph-sword', 'gm-task-card-lime'],
      ['GvG', 'ph-flag-banner', 'gm-task-card-coral'],
      ['Shadowfront', 'ph-ghost', 'gm-task-card-lilac'],
      ['Defend Trade Route', 'ph-truck', 'gm-task-card-cyan'],
      ['ARMS RACE STAGE A', 'ph-crosshair', 'gm-task-card-amber'],
      ['Glory', 'ph-trophy', 'gm-task-card-mint'],
      ['', 'ph-calendar-dot', 'gm-task-card-dark']
    ].forEach(([n, icon, theme]) => {
      expect(events.getEventIcon(n)).toBe(icon);
      expect(events.getEventTheme(n)).toBe(theme);
    });
    [[[8, 10], 0.8], [[10, 8], 1], [[0, 0], 0], [[5, 0], 1]].forEach(([[d, a], expected]) => {
      expect(events.computeShadowfrontAttendanceRate(d, a)).toBe(expected);
    });
  });
});

describe('GvG daily tasks', () => {
  it('keeps the same 6-day catalogue as gm-utils', () => {
    expect(Object.keys(GVG_DAILY_TASKS).length).toBe(6);
    expect(GVG_DAILY_TASKS[1].dayName).toBe('Monday');
  });

  it('buildGvgDailyTaskEmbed mirrors gm-utils payload shape', () => {
    const mine = events.buildGvgDailyTaskEmbed(3, '<@&123>');
    expect(mine.content).toBe('📢 **GvG Day 3 Tasks are Live!** (Wednesday · 00:01 UTC) <@&123>');
    expect(mine.embeds[0].title).toBe('⚔️ GvG Day 3 Tasks: Technology, Research, Ruins & Exploration');
    expect(mine.embeds[0].fields.length).toBe(3);
  });
});

describe('combat scoring', () => {
  const metrics = { overall_power: 100000000, fleet_rating: 2000000, flagship_power: 10000000, tech_power: 15000000, crew_power: 5000000, champion_power: 30000000, glory_score: 50000000 };
  it('calculateRallyScore / calculateWarScore match gm-utils', () => {
    expect(combat.calculateRallyScore(metrics)).toBe(596500000);
    expect(combat.calculateWarScore(metrics)).toBe(596500000);
  });
  it('calculateCombatDensity / calculateCombativity / calculateResidualPower match gm-utils', () => {
    expect(combat.calculateCombatDensity(metrics)).toBe(496.5);
    expect(combat.calculateCombativity(metrics)).toBe(0.5);
    expect(combat.calculateResidualPower(metrics)).toBe(50000000);
  });
  it('calculateRallyGrade matches gm-utils', () => {
    expect(combat.calculateRallyGrade(metrics, 500000000)).toBe(100);
  });
});

describe('async helpers', () => {
  it('runInChunks batches and preserves order', async () => {
    const seen = [];
    const out = await asyncUtils.runInChunks([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { seen.push(n); return n * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(seen.length).toBe(7);
  });

  it('debounce collapses a burst into a single call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = asyncUtils.debounce(fn, 100);
    d(); d(); d();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('getRoleInfo', () => {
  beforeEach(() => {
    localStorage.clear();
    patchAppState({ currentGuildRestriction: null });
  });

  it('derives guild_admin from R4 storage', async () => {
    localStorage.setItem('gm_role', 'R4');
    patchAppState({ currentGuildRestriction: 'ALPHA' });
    const info = await combat.getRoleInfo();
    expect(info.role).toBe('guild_admin');
    expect(info.isGuildAdmin).toBe(true);
    expect(info.guild).toBe('ALPHA');
  });

  it('promotes a stored member to server_admin when a server restriction exists', async () => {
    localStorage.setItem('gm_role', 'member');
    localStorage.setItem('gm_server_restriction', '1234');
    const info = await combat.getRoleInfo();
    expect(info.role).toBe('server_admin');
    expect(info.isServerAdmin).toBe(true);
  });
});
