/**
 * src/utils/timezone.ts
 *
 * Robust, DST-resilient timezone utilities using native Intl.DateTimeFormat.
 * Supports standard IANA timezone identifiers, live offset calculation,
 * local time formatting, and curated timezone selections for guild rosters.
 */

export interface TimezoneOption {
  zone: string;
  label: string;
  region: string;
}

export const COMMON_TIMEZONES: TimezoneOption[] = [
  // UTC / Server
  { zone: 'UTC', label: 'UTC (Server Time)', region: 'UTC' },

  // Europe
  { zone: 'Europe/London', label: 'London (GMT/BST)', region: 'Europe' },
  { zone: 'Europe/Paris', label: 'Paris, Berlin, Rome, Madrid (CET/CEST)', region: 'Europe' },
  { zone: 'Europe/Athens', label: 'Athens, Helsinki, Bucharest (EET/EEST)', region: 'Europe' },
  { zone: 'Europe/Kyiv', label: 'Kyiv (EET/EEST)', region: 'Europe' },
  { zone: 'Europe/Moscow', label: 'Moscow (MSK)', region: 'Europe' },

  // Americas
  { zone: 'America/New_York', label: 'New York, Toronto, Miami (Eastern Time)', region: 'Americas' },
  { zone: 'America/Chicago', label: 'Chicago, Dallas, Mexico City (Central Time)', region: 'Americas' },
  { zone: 'America/Denver', label: 'Denver, Phoenix (Mountain Time)', region: 'Americas' },
  { zone: 'America/Los_Angeles', label: 'Los Angeles, Vancouver, Seattle (Pacific Time)', region: 'Americas' },
  { zone: 'America/Anchorage', label: 'Anchorage (Alaska Time)', region: 'Americas' },
  { zone: 'America/Honolulu', label: 'Honolulu (Hawaii Time)', region: 'Americas' },
  { zone: 'America/Sao_Paulo', label: 'São Paulo, Rio de Janeiro (BRT)', region: 'Americas' },
  { zone: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires (ART)', region: 'Americas' },
  { zone: 'America/Bogota', label: 'Bogotá, Lima (COT/PET)', region: 'Americas' },
  { zone: 'America/Santiago', label: 'Santiago (CLT/CLST)', region: 'Americas' },

  // Asia & Middle East
  { zone: 'Asia/Dubai', label: 'Dubai, Abu Dhabi (GST)', region: 'Asia & Middle East' },
  { zone: 'Asia/Riyadh', label: 'Riyadh, Kuwait (AST)', region: 'Asia & Middle East' },
  { zone: 'Asia/Jerusalem', label: 'Jerusalem (IST/IDT)', region: 'Asia & Middle East' },
  { zone: 'Asia/Kolkata', label: 'India / New Delhi (IST)', region: 'Asia & Middle East' },
  { zone: 'Asia/Bangkok', label: 'Bangkok, Jakarta, Hanoi (ICT)', region: 'Asia & Middle East' },
  { zone: 'Asia/Singapore', label: 'Singapore, Kuala Lumpur (SGT)', region: 'Asia & Middle East' },
  { zone: 'Asia/Hong_Kong', label: 'Hong Kong, Beijing, Manila (HKT/CST)', region: 'Asia & Middle East' },
  { zone: 'Asia/Seoul', label: 'Seoul (KST)', region: 'Asia & Middle East' },
  { zone: 'Asia/Tokyo', label: 'Tokyo (JST)', region: 'Asia & Middle East' },

  // Oceania
  { zone: 'Australia/Perth', label: 'Perth (AWST)', region: 'Oceania' },
  { zone: 'Australia/Adelaide', label: 'Adelaide (ACST/ACDT)', region: 'Oceania' },
  { zone: 'Australia/Sydney', label: 'Sydney, Melbourne (AEST/AEDT)', region: 'Oceania' },
  { zone: 'Australia/Brisbane', label: 'Brisbane (AEST)', region: 'Oceania' },
  { zone: 'Pacific/Auckland', label: 'Auckland, Wellington (NZST/NZDT)', region: 'Oceania' },

  // Africa
  { zone: 'Africa/Cairo', label: 'Cairo (EET/EEST)', region: 'Africa' },
  { zone: 'Africa/Johannesburg', label: 'Johannesburg, Cape Town (SAST)', region: 'Africa' },
  { zone: 'Africa/Lagos', label: 'Lagos (WAT)', region: 'Africa' },
  { zone: 'Africa/Nairobi', label: 'Nairobi (EAT)', region: 'Africa' },
  { zone: 'Africa/Casablanca', label: 'Casablanca (WEST)', region: 'Africa' }
];

/**
 * Check whether a timezone string is recognized and supported by Intl.
 */
export function isValidTimezone(timeZone?: string | null): boolean {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Detect the user's browser timezone via Intl.
 */
export function detectUserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(tz) ? tz : 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

/**
 * Compute the exact UTC offset in hours (e.g. +2, -5, +5.5) for a given timezone and date.
 * Handles Daylight Saving Time (DST) automatically.
 */
export function getTimezoneOffset(timeZone: string, date: Date = new Date()): number {
  if (!isValidTimezone(timeZone)) return 0;
  try {
    const utcFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });

    const tzFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });

    const utcParts = utcFormatter.formatToParts(date);
    const tzParts = tzFormatter.formatToParts(date);

    const getPart = (parts: Intl.DateTimeFormatPart[], type: string): number => {
      const p = parts.find((item) => item.type === type);
      return p ? parseInt(p.value, 10) : 0;
    };

    const dUtc = Date.UTC(
      getPart(utcParts, 'year'),
      getPart(utcParts, 'month') - 1,
      getPart(utcParts, 'day'),
      getPart(utcParts, 'hour') % 24,
      getPart(utcParts, 'minute'),
      getPart(utcParts, 'second')
    );

    const dTz = Date.UTC(
      getPart(tzParts, 'year'),
      getPart(tzParts, 'month') - 1,
      getPart(tzParts, 'day'),
      getPart(tzParts, 'hour') % 24,
      getPart(tzParts, 'minute'),
      getPart(tzParts, 'second')
    );

    return (dTz - dUtc) / (1000 * 60 * 60);
  } catch (_) {
    return 0;
  }
}

/**
 * Format an offset number (e.g. 2, -5, 5.5) into standard label (e.g. 'UTC+2', 'UTC-5', 'UTC+5:30').
 */
export function formatOffsetLabel(offset: number): string {
  if (isNaN(offset) || offset === 0) return 'UTC';
  const sign = offset > 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hours = Math.floor(abs);
  const minutes = Math.round((abs - hours) * 60);
  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }
  return `UTC${sign}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}

/**
 * Format live time in a given timezone (HH:MM:SS or HH:MM).
 */
export function formatTimeInZone(timeZone: string, date: Date = new Date(), withSeconds = true): string {
  try {
    const tz = isValidTimezone(timeZone) ? timeZone : 'UTC';
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined,
      hour12: false
    });
    return formatter.format(date);
  } catch (_) {
    return withSeconds ? '--:--:--' : '--:--';
  }
}

/**
 * Format a complete display badge object for a member.
 */
export function formatTimezoneDisplay(
  timeZone?: string | null,
  fallbackOffset?: number | null,
  date: Date = new Date()
): {
  offsetText: string;
  timeText: string;
  tooltip: string;
  offset: number;
} | null {
  if (timeZone && isValidTimezone(timeZone)) {
    const offset = getTimezoneOffset(timeZone, date);
    const offsetText = formatOffsetLabel(offset);
    const timeText = formatTimeInZone(timeZone, date, false);
    return {
      offset,
      offsetText,
      timeText,
      tooltip: `Local time: ${timeText} (${timeZone} • ${offsetText})`
    };
  }

  if (fallbackOffset != null && !isNaN(Number(fallbackOffset))) {
    const offset = Number(fallbackOffset);
    const offsetText = formatOffsetLabel(offset);
    const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
    const targetDate = new Date(utcMs + 3600000 * offset);
    const h = String(targetDate.getHours()).padStart(2, '0');
    const m = String(targetDate.getMinutes()).padStart(2, '0');
    const timeText = `${h}:${m}`;
    return {
      offset,
      offsetText,
      timeText,
      tooltip: `Local time: ~${timeText} (${offsetText})`
    };
  }

  return null;
}
