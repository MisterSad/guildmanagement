/**
 * tests/core_pure_utils.test.js
 *
 * Phase 1 (Sous-lot 5.2A) parity suite for the pure helpers ported from
 * gm-utils.js into /src/core. The legacy root script is still loaded during
 * Phase 1 and used as the parity oracle where it exposes the same function.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import * as text from '../src/core/utils/text';
import * as date from '../src/core/utils/date';
import * as events from '../src/core/config/events';
import * as combat from '../src/core/scoring/combat';
import * as asyncUtils from '../src/core/utils/async';
import { GVG_DAILY_TASKS } from '../src/core/config/gvg-daily-tasks';

const GM = window.GM;

afterEach(() => {
  vi.useRealTimers();
});

describe('escapeHTML — strict XSS parity', () => {
  const samples = [
    '<script>alert("xss")</script>',
    `A&B 'quote' "double" \`tick\``,
    'plain text',
    '<img src=x onerror=alert(1)>',
    ''
  ];
  samples.forEach((s, i) => {
    it('matches gm-utils for sample #' + i, () => {
      expect(text.escapeHTML(s)).toBe(GM.escapeHTML(s));
    });
  });
});

describe('validation & roles', () => {
  it('validatePseudo matches gm-utils', () => {
    ['OkPseudo', '', '   ', 'a'.repeat(33), '<b>', 'nice_name-1', null, 42].forEach((v) => {
      expect(text.validatePseudo(v)).toBe(GM.validatePseudo(v));
    });
  });

  it('validateUid matches gm-utils', () => {
    ['', null, '123456', '12345', '12345678901', 'abc123', '12345a', '1234567890'].forEach((v) => {
      expect(text.validateUid(v)).toBe(GM.validateUid(v));
    });
  });

  it('normalizeRole matches gm-utils', () => {
    ['R5', 'R4', 'admin', 'server_admin', 'super_admin', 'guild_admin', 'member', 'x', null].forEach((v) => {
      expect(text.normalizeRole(v)).toBe(GM.normalizeRole(v));
    });
  });
});

describe('similarity & levenshtein', () => {
  it('levenshteinDistance matches gm-utils', () => {
    [['kitten', 'sitting'], ['', 'abc'], ['abc', ''], ['same', 'same'], ['[PR1M]Alpha', 'Alpha']].forEach(([a, b]) => {
      expect(text.levenshteinDistance(a, b)).toBe(GM.levenshteinDistance(a, b));
    });
  });

  it('calculateStringSimilarity matches gm-utils', () => {
    [['[PR1M]Alpha', 'Alpha'], ['StarWarrior99', 'star warrior 99'], ['aaaa', 'bbbb'], ['x', 'x']].forEach(([a, b]) => {
      expect(text.calculateStringSimilarity(a, b)).toBe(GM.calculateStringSimilarity(a, b));
    });
  });
});

describe('numbers', () => {
  it('parseNumber matches gm-utils', () => {
    [null, '', '0', '12 345', 'abc', 42, '99999999999999'].forEach((v) => {
      expect(text.parseNumber(v)).toBe(GM.parseNumber(v));
    });
  });

  it('formatNumber matches gm-utils', () => {
    [null, '', 0, 1000000, '1 234 567', 'abc', 99999999999999].forEach((v) => {
      expect(text.formatNumber(v)).toBe(GM.formatNumber(v));
    });
  });

  it('formatPower matches gm-utils', () => {
    [null, '', 0, 999, 1500, 2500000, 1500000000].forEach((v) => {
      expect(text.formatPower(v)).toBe(GM.formatPower(v));
    });
  });

  it('parseSafeMetric handles commas and negatives', () => {
    expect(combat.parseSafeMetric('1,234.5')).toBe(1234.5);
    expect(combat.parseSafeMetric(-5)).toBe(0);
    expect(combat.parseSafeMetric('abc')).toBe(0);
    expect(combat.parseSafeMetric(null)).toBe(0);
  });

  it('getPowerTier / getPowerTierMeta match gm-utils', () => {
    [[50, 100], [80, 100], [65, 100], [45, 100], [10, 100], [0, 0]].forEach(([p, m]) => {
      expect(combat.getPowerTier(p, m)).toBe(GM.getPowerTier(p, m));
      expect(combat.getPowerTierMeta(combat.getPowerTier(p, m))).toEqual(GM.getPowerTierMeta(GM.getPowerTier(p, m)));
    });
  });
});

describe('dates', () => {
  const fixed = ['2026-08-03T10:00:00Z', '2026-01-01T00:00:00Z', '2025-12-31T23:59:00Z'];
  it('getWeekStart / getPrevWeekStart / formatWeek match gm-utils', () => {
    fixed.forEach((d) => {
      const ws = date.getWeekStart(d);
      expect(ws).toBe(GM.getWeekStart(d));
      expect(date.getPrevWeekStart(ws)).toBe(GM.getPrevWeekStart(ws));
      expect(date.formatWeek(ws)).toBe(GM.formatWeek(ws));
    });
  });

  it('formatDateTimeUTC matches gm-utils', () => {
    fixed.forEach((d) => {
      expect(date.formatDateTimeUTC(d)).toBe(GM.formatDateTimeUTC(d));
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
    [['SvS'], ['GvG'], ['Arms Race Stage A'], ['Arms Race Stage B'], ['Defend Trade Route'], ['Shadowfront Squad 1'], ['Shadowfront Squad 2']].forEach(([ev]) => {
      const ids = [];
      const first = events.buildEventSessionId(ev, ref, ids);
      expect(first).toBe(GM.buildEventSessionId(ev, ref, ids));
      ids.push(first);
      expect(events.buildEventSessionId(ev, ref, ids)).toBe(GM.buildEventSessionId(ev, ref, ids));
    });
  });

  it('eventScoringKey matches gm-utils', () => {
    [['SvS', 's1', '2026-08-03'], ['GvG', 's1', '2026-08-03'], ['ARMS RACE STAGE A', 'a1', '2026-08-03'], ['Shadowfront', 's1', '2026-08-03'], ['Defend Trade Route', 'd1', '2026-08-03']].forEach(([ev, sid, ws]) => {
      expect(events.eventScoringKey(ev, sid, ws)).toBe(GM.eventScoringKey(ev, sid, ws));
    });
  });

  it('sessionDateFromId matches gm-utils', () => {
    ['ARA-20260815-1', 'SVS-2026-W32', 'nope'].forEach((sid) => {
      const a = events.sessionDateFromId(sid);
      const b = GM.sessionDateFromId(sid);
      expect(a ? a.toISOString() : null).toBe(b ? b.toISOString() : null);
    });
  });

  it('getEventIcon / getEventTheme / computeShadowfrontAttendanceRate match gm-utils', () => {
    ['SvS', 'GvG', 'Shadowfront', 'Defend Trade Route', 'ARMS RACE STAGE A', 'Glory', ''].forEach((n) => {
      expect(events.getEventIcon(n)).toBe(GM.getEventIcon(n));
      expect(events.getEventTheme(n)).toBe(GM.getEventTheme(n));
    });
    [[8, 10], [10, 8], [0, 0], [5, 0]].forEach(([d, a]) => {
      expect(events.computeShadowfrontAttendanceRate(d, a)).toBe(GM.computeShadowfrontAttendanceRate(d, a));
    });
  });
});

describe('GvG daily tasks', () => {
  it('keeps the same 6-day catalogue as gm-utils', () => {
    expect(Object.keys(GVG_DAILY_TASKS).length).toBe(Object.keys(GM.gvgTasks.GVG_DAILY_TASKS).length);
    expect(GVG_DAILY_TASKS[1].dayName).toBe('Monday');
  });

  it('buildGvgDailyTaskEmbed mirrors gm-utils payload shape', () => {
    const mine = events.buildGvgDailyTaskEmbed(3, '<@&123>');
    const legacy = GM.gvgTasks.buildGvgDailyTaskEmbed(3, '<@&123>');
    expect(mine.content).toBe(legacy.content);
    expect(mine.embeds[0].title).toBe(legacy.embeds[0].title);
    expect(mine.embeds[0].fields.length).toBe(legacy.embeds[0].fields.length);
  });
});

describe('combat scoring', () => {
  const metrics = { overall_power: 100000000, fleet_rating: 2000000, flagship_power: 10000000, tech_power: 15000000, crew_power: 5000000, champion_power: 30000000, glory_score: 50000000 };
  it('calculateRallyScore / calculateWarScore match gm-utils', () => {
    expect(combat.calculateRallyScore(metrics)).toBe(GM.calculateRallyScore(metrics));
    expect(combat.calculateWarScore(metrics)).toBe(GM.calculateWarScore(metrics));
  });
  it('calculateCombatDensity / calculateCombativity / calculateResidualPower match gm-utils', () => {
    expect(combat.calculateCombatDensity(metrics)).toBe(GM.calculateCombatDensity(metrics));
    expect(combat.calculateCombativity(metrics)).toBe(GM.calculateCombativity(metrics));
    expect(combat.calculateResidualPower(metrics)).toBe(GM.calculateResidualPower(metrics));
  });
  it('calculateRallyGrade matches gm-utils', () => {
    expect(combat.calculateRallyGrade(metrics, 500000000)).toBe(GM.calculateRallyGrade(metrics, 500000000));
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
    delete (window).currentGuildRestriction;
  });

  it('derives guild_admin from R4 storage', async () => {
    localStorage.setItem('gm_role', 'R4');
    window.currentGuildRestriction = 'ALPHA';
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
