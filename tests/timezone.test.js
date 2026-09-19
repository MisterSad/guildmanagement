import { describe, it, expect } from 'vitest';
import {
  COMMON_TIMEZONES,
  isValidTimezone,
  detectUserTimezone,
  getTimezoneOffset,
  formatOffsetLabel,
  formatTimeInZone,
  formatTimezoneDisplay
} from '../src/utils/timezone';

describe('src/utils/timezone.ts — IANA Timezone Engine', () => {
  describe('1. Validation & Detection', () => {
    it('validates recognized IANA timezones', () => {
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('Europe/Paris')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('Asia/Tokyo')).toBe(true);
      expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    });

    it('rejects invalid timezone strings', () => {
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
      expect(isValidTimezone(undefined)).toBe(false);
      expect(isValidTimezone('Invalid/Zone_Name')).toBe(false);
      expect(isValidTimezone('GMT+2')).toBe(false);
    });

    it('detects user timezone safely with fallback to UTC', () => {
      const tz = detectUserTimezone();
      expect(typeof tz).toBe('string');
      expect(isValidTimezone(tz)).toBe(true);
    });

    it('provides common timezones list with non-empty categories', () => {
      expect(COMMON_TIMEZONES.length).toBeGreaterThan(15);
      const regions = new Set(COMMON_TIMEZONES.map((t) => t.region));
      expect(regions.has('Europe')).toBe(true);
      expect(regions.has('Americas')).toBe(true);
      expect(regions.has('Asia & Middle East')).toBe(true);
      expect(regions.has('UTC')).toBe(true);
    });
  });

  describe('2. Offset Calculation & DST Awareness', () => {
    it('calculates UTC offset as 0 for UTC', () => {
      const offset = getTimezoneOffset('UTC');
      expect(offset).toBe(0);
    });

    it('calculates offset for Asia/Tokyo as +9 year-round (no DST)', () => {
      const winter = new Date('2026-01-15T12:00:00Z');
      const summer = new Date('2026-07-15T12:00:00Z');
      expect(getTimezoneOffset('Asia/Tokyo', winter)).toBe(9);
      expect(getTimezoneOffset('Asia/Tokyo', summer)).toBe(9);
    });

    it('calculates half-hour offset for Asia/Kolkata (+5.5)', () => {
      const d = new Date('2026-06-01T12:00:00Z');
      expect(getTimezoneOffset('Asia/Kolkata', d)).toBe(5.5);
    });

    it('handles DST in Europe/Paris (UTC+1 in winter, UTC+2 in summer)', () => {
      const winter = new Date('2026-01-15T12:00:00Z');
      const summer = new Date('2026-07-15T12:00:00Z');
      expect(getTimezoneOffset('Europe/Paris', winter)).toBe(1);
      expect(getTimezoneOffset('Europe/Paris', summer)).toBe(2);
    });

    it('handles DST in America/New_York (UTC-5 in winter, UTC-4 in summer)', () => {
      const winter = new Date('2026-01-15T12:00:00Z');
      const summer = new Date('2026-07-15T12:00:00Z');
      expect(getTimezoneOffset('America/New_York', winter)).toBe(-5);
      expect(getTimezoneOffset('America/New_York', summer)).toBe(-4);
    });

    it('returns 0 for invalid timezones', () => {
      expect(getTimezoneOffset('Not/A_Zone')).toBe(0);
    });
  });

  describe('3. Offset & Time Formatting', () => {
    it('formats offset labels correctly', () => {
      expect(formatOffsetLabel(0)).toBe('UTC');
      expect(formatOffsetLabel(2)).toBe('UTC+2');
      expect(formatOffsetLabel(-5)).toBe('UTC-5');
      expect(formatOffsetLabel(5.5)).toBe('UTC+5:30');
      expect(formatOffsetLabel(-3.5)).toBe('UTC-3:30');
    });

    it('formats time in zone matching 24h format', () => {
      const d = new Date('2026-06-15T10:30:45Z');
      // London in summer is BST (UTC+1) -> 11:30:45
      const timeLondon = formatTimeInZone('Europe/London', d, true);
      expect(timeLondon).toBe('11:30:45');

      const timeLondonShort = formatTimeInZone('Europe/London', d, false);
      expect(timeLondonShort).toBe('11:30');

      // Tokyo is UTC+9 -> 19:30:45
      const timeTokyo = formatTimeInZone('Asia/Tokyo', d, true);
      expect(timeTokyo).toBe('19:30:45');
    });

    it('formats display badge correctly with IANA timezone', () => {
      const d = new Date('2026-07-15T10:00:00Z');
      const badge = formatTimezoneDisplay('Europe/Paris', null, d);
      expect(badge).not.toBeNull();
      expect(badge?.offsetText).toBe('UTC+2');
      expect(badge?.timeText).toBe('12:00');
      expect(badge?.tooltip).toContain('Europe/Paris');
      expect(badge?.tooltip).toContain('12:00');
    });

    it('formats display badge with fallback numeric offset if timezone is missing', () => {
      const d = new Date('2026-07-15T12:00:00Z');
      const badge = formatTimezoneDisplay(null, 3, d);
      expect(badge).not.toBeNull();
      expect(badge?.offsetText).toBe('UTC+3');
      expect(badge?.tooltip).toContain('UTC+3');
    });

    it('returns null if neither timezone nor offset is provided', () => {
      expect(formatTimezoneDisplay(null, null)).toBeNull();
      expect(formatTimezoneDisplay('', undefined)).toBeNull();
    });
  });

  describe('4. Automated Officer Clocks', () => {
    // Dynamically import buildOfficerClocks from overview.service
    it('generates officer clocks automatically for R4 and R5 members with timezone', async () => {
      const { buildOfficerClocks } = await import('../src/modules/overview/overview.service');

      const members = [
        { pseudo: 'Soldier', role: 'R1', timezone: 'Europe/Paris' },
        { pseudo: 'Captain', role: 'R4', timezone: 'America/New_York' },
        { pseudo: 'Leader', role: 'R5', timezone: 'Europe/Paris' },
        { pseudo: 'NoTzOfficer', role: 'R4', timezone: null, timezone_offset: null },
        { pseudo: 'OffsetOfficer', role: 'R4', timezone: null, timezone_offset: 3 }
      ];

      const summer = new Date('2026-07-15T12:00:00Z');
      const clocks = buildOfficerClocks(members, summer);

      expect(clocks.length).toBe(3);
      // R5 first
      expect(clocks[0].name).toBe('Leader');
      expect(clocks[0].role).toBe('R5');
      expect(clocks[0].color).toBe('warning');
      expect(clocks[0].offset).toBe(2); // Europe/Paris in summer = UTC+2

      // R4s next
      expect(clocks[1].name).toBe('Captain');
      expect(clocks[1].role).toBe('R4');
      expect(clocks[1].offset).toBe(-4); // America/New_York in summer = UTC-4

      expect(clocks[2].name).toBe('OffsetOfficer');
      expect(clocks[2].role).toBe('R4');
      expect(clocks[2].offset).toBe(3);
    });

    it('returns empty array when no officers have timezones', async () => {
      const { buildOfficerClocks } = await import('../src/modules/overview/overview.service');
      const members = [
        { pseudo: 'Player1', role: 'R1', timezone: 'UTC' },
        { pseudo: 'Leader', role: 'R5', timezone: null, timezone_offset: null }
      ];
      expect(buildOfficerClocks(members)).toEqual([]);
    });
  });
});
