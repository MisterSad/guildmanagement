import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';

const RAD = window.GM;
expect(RAD).toBeTruthy();

describe('escapeHTML', () => {
    it('escapes HTML special chars', () => {
        expect(RAD.escapeHTML('<script>alert("x")</script>')).toBe(
            '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
        );
    });
    it('escapes quotes and backticks', () => {
        expect(RAD.escapeHTML("it's `code`")).toBe('it&#39;s &#96;code&#96;');
    });
    it('returns empty string for null/undefined', () => {
        expect(RAD.escapeHTML(null)).toBe('null');
        expect(RAD.escapeHTML(undefined)).toBe('undefined');
    });
});

describe('formatNumber', () => {
    it('formats with space thousands separator', () => {
        expect(RAD.formatNumber(1234567)).toBe('1 234 567');
        expect(RAD.formatNumber('1234567')).toBe('1 234 567');
        expect(RAD.formatNumber(0)).toBe('0');
    });
    it('caps at MAX_NUMERIC', () => {
        expect(RAD.formatNumber(99999999999)).toBe('9 999 999 999');
    });
    it('returns empty string for null/undefined/empty', () => {
        expect(RAD.formatNumber(null)).toBe('');
        expect(RAD.formatNumber(undefined)).toBe('');
        expect(RAD.formatNumber('')).toBe('');
    });
});

describe('parseNumber', () => {
    it('strips non-digits and parses', () => {
        expect(RAD.parseNumber('12 345')).toBe(12345);
        expect(RAD.parseNumber('abc')).toBe(null);
        expect(RAD.parseNumber('')).toBe(null);
        expect(RAD.parseNumber(null)).toBe(null);
    });
    it('caps at MAX_NUMERIC', () => {
        expect(RAD.parseNumber('99999999999999')).toBe(RAD.MAX_NUMERIC);
    });
});

describe('avatarInit', () => {
    it('uses camelCase boundary', () => {
        expect(RAD.avatarInit('HakwTuah')).toBe('HT');
        expect(RAD.avatarInit('StarWarrior99')).toBe('SW');
    });
    it('handles separators', () => {
        expect(RAD.avatarInit('lower_case')).toBe('LC');
        expect(RAD.avatarInit('ab')).toBe('AB');
    });
    it('falls back to question mark', () => {
        expect(RAD.avatarInit('')).toBe('?');
        expect(RAD.avatarInit(null)).toBe('?');
    });
});

describe('week helpers (UTC Mondays)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-02T10:00:00Z')); // Sunday
    });
    afterEach(() => vi.useRealTimers());

    it('getWeekStart returns the UTC Monday of the current week', () => {
        expect(RAD.getWeekStart()).toBe('2026-07-27');
    });
    it('getWeekStart honors a given date', () => {
        expect(RAD.getWeekStart('2026-08-05T12:00:00Z')).toBe('2026-08-03');
        expect(RAD.getWeekStart('2026-07-27T23:59:59Z')).toBe('2026-07-27');
    });
    it('getPrevWeekStart subtracts 7 days', () => {
        expect(RAD.getPrevWeekStart('2026-07-27')).toBe('2026-07-20');
    });
    it('formatWeek renders the Monday → Sunday range', () => {
        expect(RAD.formatWeek('2026-07-27')).toBe('27/07 → 02/08/2026');
        expect(RAD.formatWeek('')).toBe('');
        expect(RAD.formatWeek('garbage')).toBe('garbage');
    });
    it('newSessionId returns an ISO timestamp', () => {
        expect(new Date(RAD.newSessionId()).getTime()).toBe(
            new Date('2026-08-02T10:00:00Z').getTime()
        );
    });
});

describe('formatDateTimeUTC', () => {
    it('formats ISO to UTC wall-clock label', () => {
        expect(RAD.formatDateTimeUTC('2026-07-27T20:00:00Z')).toContain('20:00 UTC');
        expect(RAD.formatDateTimeUTC('2026-07-27T20:00:00Z')).toContain('27/07');
        expect(RAD.formatDateTimeUTC('')).toBe('');
        expect(RAD.formatDateTimeUTC('not-a-date')).toBe('');
    });
});

describe('validatePseudo', () => {
    it('accepts a valid pseudo', () => {
        expect(RAD.validatePseudo('StarWarrior99')).toBe(null);
    });
    it('rejects empty / too long', () => {
        expect(RAD.validatePseudo('')).toBe('validation_pseudo_empty');
        expect(RAD.validatePseudo('   ')).toBe('validation_pseudo_empty');
        expect(RAD.validatePseudo('x'.repeat(33))).toBe('validation_pseudo_too_long');
    });
    it('rejects dangerous chars', () => {
        expect(RAD.validatePseudo('<script>')).toBe('validation_pseudo_invalid_chars');
        expect(RAD.validatePseudo('a"b')).toBe('validation_pseudo_invalid_chars');
        expect(RAD.validatePseudo('a\\b')).toBe('validation_pseudo_invalid_chars');
    });
});

describe('validateUid', () => {
    it('accepts digits only', () => {
        expect(RAD.validateUid('123456')).toBe(null);
    });
    it('treats empty as optional', () => {
        expect(RAD.validateUid('')).toBe(null);
        expect(RAD.validateUid(null)).toBe(null);
    });
    it('rejects non-numeric and too long', () => {
        expect(RAD.validateUid('12abc')).toBe('validation_uid_not_numeric');
        expect(RAD.validateUid('1'.repeat(21))).toBe('validation_uid_too_long');
    });
});

describe('formatPower', () => {
    it('formats big numbers with B/M/K suffixes', () => {
        expect(RAD.formatPower(1500000000)).toBe('1.5B');
        expect(RAD.formatPower(1500000)).toBe('1.5M');
        expect(RAD.formatPower(1500)).toBe('1.5K');
        expect(RAD.formatPower(999)).toBe('999');
        expect(RAD.formatPower('')).toBe('—');
    });
});

describe('getPowerTier', () => {
    it('computes tiers from power ratio', () => {
        expect(RAD.getPowerTier(800, 1000)).toBe('S');
        expect(RAD.getPowerTier(600, 1000)).toBe('A');
        expect(RAD.getPowerTier(400, 1000)).toBe('B');
        expect(RAD.getPowerTier(200, 1000)).toBe('C');
        expect(RAD.getPowerTier(100, 1000)).toBe('D');
        expect(RAD.getPowerTier(0, 1000)).toBe('D');
        expect(RAD.getPowerTier(500, 0)).toBe('D');
    });
    it('maps tiers to display metadata', () => {
        expect(RAD.getPowerTierMeta('S').label).toBe('Mythic');
        expect(RAD.getPowerTierMeta('A').label).toBe('Legendary');
        expect(RAD.getPowerTierMeta('B').label).toBe('Epic');
        expect(RAD.getPowerTierMeta('C').label).toBe('Rare');
        expect(RAD.getPowerTierMeta('Z').label).toBe('Common');
    });
});

describe('event theming helpers', () => {
    it('getEventIcon maps known event names', () => {
        expect(RAD.getEventIcon('SvS Battle')).toBe('ph-swords');
        expect(RAD.getEventIcon('GvG War')).toBe('ph-flag-banner');
        expect(RAD.getEventIcon('Shadowfront')).toBe('ph-ghost');
        expect(RAD.getEventIcon('Trade Route DTR')).toBe('ph-truck');
        expect(RAD.getEventIcon('Arms Race')).toBe('ph-crosshair');
        expect(RAD.getEventIcon('Glory')).toBe('ph-trophy');
        expect(RAD.getEventIcon('Unknown')).toBe('ph-calendar-dot');
    });
    it('getEventTheme maps known event names', () => {
        expect(RAD.getEventTheme('SvS')).toBe('gm-task-card-lime');
        expect(RAD.getEventTheme('GvG')).toBe('gm-task-card-coral');
        expect(RAD.getEventTheme('Shadowfront')).toBe('gm-task-card-lilac');
        expect(RAD.getEventTheme('DTR')).toBe('gm-task-card-cyan');
        expect(RAD.getEventTheme('Arms Race')).toBe('gm-task-card-amber');
        expect(RAD.getEventTheme('Glory')).toBe('gm-task-card-mint');
        expect(RAD.getEventTheme('Unknown')).toBe('gm-task-card-dark');
    });
});
