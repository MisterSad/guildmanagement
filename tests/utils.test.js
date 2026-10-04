import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  escapeHTML,
  MAX_NUMERIC,
  formatNumber,
  parseNumber,
  formatPower,
  avatarInit,
  validatePseudo,
  validateUid,
} from '../src/core/utils/text';
import { getPowerTier, getPowerTierMeta } from '../src/core/utils/numbers';
import { getWeekStart, getPrevWeekStart, formatWeek, formatDateTimeUTC, newSessionId } from '../src/core/utils/date';
import { getEventIcon, getEventTheme } from '../src/core/config/events';

describe('escapeHTML', () => {
  it('escapes HTML special chars', () => {
    expect(escapeHTML('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
  it('escapes quotes and backticks', () => {
    expect(escapeHTML("it's `code`")).toBe('it&#39;s &#96;code&#96;');
  });
  it('renders nullish input as empty, never as the word "null"', () => {
    // Behaviour change, deliberately. There were two escapeHTML
    // implementations assigned to the bridge's escapeHTML in sequence --
    // main.ts set the core/api/supabase one (returned ''), then
    // installGmBridge() overwrote it with the core/utils/text one
    // (stringified to 'null'), so which one won depended purely on load
    // order. They are now a single implementation, and it returns ''.
    //
    // '' is the right answer: printing the literal word "null" into the UI
    // is a defect, and it matches the convention formatNumber already
    // follows below for nullish input.
    expect(escapeHTML(null)).toBe('');
    expect(escapeHTML(undefined)).toBe('');
  });
});

describe('formatNumber', () => {
  it('formats with space thousands separator', () => {
    expect(formatNumber(1234567)).toBe('1 234 567');
    expect(formatNumber('1234567')).toBe('1 234 567');
    expect(formatNumber(0)).toBe('0');
  });
  it('caps at MAX_NUMERIC', () => {
    expect(formatNumber(99999999999)).toBe('9 999 999 999');
  });
  it('returns empty string for null/undefined/empty', () => {
    expect(formatNumber(null)).toBe('');
    expect(formatNumber(undefined)).toBe('');
    expect(formatNumber('')).toBe('');
  });
});

describe('parseNumber', () => {
  it('strips non-digits and parses', () => {
    expect(parseNumber('12 345')).toBe(12345);
    expect(parseNumber('abc')).toBe(null);
    expect(parseNumber('')).toBe(null);
    expect(parseNumber(null)).toBe(null);
  });
  it('caps at MAX_NUMERIC', () => {
    expect(parseNumber('99999999999999')).toBe(MAX_NUMERIC);
  });
});

describe('avatarInit', () => {
  it('uses camelCase boundary', () => {
    expect(avatarInit('HakwTuah')).toBe('HT');
    expect(avatarInit('StarWarrior99')).toBe('SW');
  });
  it('handles separators', () => {
    expect(avatarInit('lower_case')).toBe('LC');
    expect(avatarInit('ab')).toBe('AB');
  });
  it('falls back to question mark', () => {
    expect(avatarInit('')).toBe('?');
    expect(avatarInit(null)).toBe('?');
  });
});

describe('week helpers (UTC Mondays)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00Z')); // Sunday
  });
  afterEach(() => vi.useRealTimers());

  it('getWeekStart returns the UTC Monday of the current week', () => {
    expect(getWeekStart()).toBe('2026-07-27');
  });
  it('getWeekStart honors a given date', () => {
    expect(getWeekStart('2026-08-05T12:00:00Z')).toBe('2026-08-03');
    expect(getWeekStart('2026-07-27T23:59:59Z')).toBe('2026-07-27');
  });
  it('getPrevWeekStart subtracts 7 days', () => {
    expect(getPrevWeekStart('2026-07-27')).toBe('2026-07-20');
  });
  it('formatWeek renders the Monday → Sunday range', () => {
    expect(formatWeek('2026-07-27')).toBe('27/07 → 02/08/2026');
    expect(formatWeek('')).toBe('');
    expect(formatWeek('garbage')).toBe('garbage');
  });
  it('newSessionId returns an ISO timestamp', () => {
    expect(new Date(newSessionId()).getTime()).toBe(new Date('2026-08-02T10:00:00Z').getTime());
  });
});

describe('formatDateTimeUTC', () => {
  it('formats ISO to UTC wall-clock label', () => {
    expect(formatDateTimeUTC('2026-07-27T20:00:00Z')).toContain('20:00 UTC');
    expect(formatDateTimeUTC('2026-07-27T20:00:00Z')).toContain('27/07');
    expect(formatDateTimeUTC('')).toBe('');
    expect(formatDateTimeUTC('not-a-date')).toBe('');
  });
});

describe('validatePseudo', () => {
  it('accepts a valid pseudo', () => {
    expect(validatePseudo('StarWarrior99')).toBe(null);
  });
  it('rejects empty / too long', () => {
    expect(validatePseudo('')).toBe('validation_pseudo_empty');
    expect(validatePseudo('   ')).toBe('validation_pseudo_empty');
    expect(validatePseudo('x'.repeat(33))).toBe('validation_pseudo_too_long');
  });
  it('rejects dangerous chars', () => {
    expect(validatePseudo('<script>')).toBe('validation_pseudo_invalid_chars');
    expect(validatePseudo('a"b')).toBe('validation_pseudo_invalid_chars');
    expect(validatePseudo('a\\b')).toBe('validation_pseudo_invalid_chars');
  });
});

describe('validateUid', () => {
  it('accepts digits only', () => {
    expect(validateUid('123456')).toBe(null);
  });
  it('treats empty as optional', () => {
    expect(validateUid('')).toBe(null);
    expect(validateUid(null)).toBe(null);
  });
  it('rejects non-numeric and too long', () => {
    expect(validateUid('12abc')).toBe('validation_uid_not_numeric');
    expect(validateUid('1'.repeat(21))).toBe('validation_uid_too_long');
  });
});

describe('formatPower', () => {
  it('formats big numbers with B/M/K suffixes', () => {
    expect(formatPower(1500000000)).toBe('1.5B');
    expect(formatPower(1500000)).toBe('1.5M');
    expect(formatPower(1500)).toBe('1.5K');
    expect(formatPower(999)).toBe('999');
    expect(formatPower('')).toBe('-');
  });
});

describe('getPowerTier', () => {
  it('computes tiers from power ratio', () => {
    expect(getPowerTier(800, 1000)).toBe('S');
    expect(getPowerTier(600, 1000)).toBe('A');
    expect(getPowerTier(400, 1000)).toBe('B');
    expect(getPowerTier(200, 1000)).toBe('C');
    expect(getPowerTier(100, 1000)).toBe('D');
    expect(getPowerTier(0, 1000)).toBe('D');
    expect(getPowerTier(500, 0)).toBe('D');
  });
  it('maps tiers to display metadata', () => {
    expect(getPowerTierMeta('S').label).toBe('Mythic');
    expect(getPowerTierMeta('A').label).toBe('Legendary');
    expect(getPowerTierMeta('B').label).toBe('Epic');
    expect(getPowerTierMeta('C').label).toBe('Rare');
    expect(getPowerTierMeta('Z').label).toBe('Common');
  });
});

describe('event theming helpers', () => {
  it('getEventIcon maps known event names', () => {
    // 'ph-swords' is not a Phosphor icon and rendered as nothing; the real name is singular.
    expect(getEventIcon('SvS Battle')).toBe('ph-sword');
    expect(getEventIcon('GvG War')).toBe('ph-flag-banner');
    expect(getEventIcon('Shadowfront')).toBe('ph-ghost');
    expect(getEventIcon('Trade Route DTR')).toBe('ph-truck');
    expect(getEventIcon('Arms Race')).toBe('ph-crosshair');
    expect(getEventIcon('Glory')).toBe('ph-trophy');
    expect(getEventIcon('Unknown')).toBe('ph-calendar-dot');
  });
  it('getEventTheme maps known event names', () => {
    expect(getEventTheme('SvS')).toBe('gm-task-card-lime');
    expect(getEventTheme('GvG')).toBe('gm-task-card-coral');
    expect(getEventTheme('Shadowfront')).toBe('gm-task-card-lilac');
    expect(getEventTheme('DTR')).toBe('gm-task-card-cyan');
    expect(getEventTheme('Arms Race')).toBe('gm-task-card-amber');
    expect(getEventTheme('Glory')).toBe('gm-task-card-mint');
    expect(getEventTheme('Unknown')).toBe('gm-task-card-dark');
  });
});
