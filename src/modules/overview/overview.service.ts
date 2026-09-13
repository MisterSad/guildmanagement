/**
 * src/modules/overview/overview.service.ts
 *
 * Pure helpers extracted from the root `overview.js` (event-name prettifying,
 * countdown/relative-time formatting, big-number formatting, timezone-clock
 * persistence shape). No DOM, no globals.
 */

export interface ClockMember {
  name: string;
  offset: number;
  color: string;
}

export function prettyEventName(n?: string | null): string {
  if (!n) return '';
  if (n === 'ARMS RACE STAGE A') return 'Arms Race Stage A';
  if (n === 'ARMS RACE STAGE B') return 'Arms Race Stage B';
  if (n === 'Shadowfront Squad 1') return 'Shadowfront - Squad 1';
  if (n === 'Shadowfront Squad 2') return 'Shadowfront - Squad 2';
  if (n === 'Defend Trade Route') return 'DTR';
  return n;
}

/** Like prettyEventName but never abbreviates (used in the upcoming agenda). */
export function fullEventName(n?: string | null): string {
  if (!n) return '';
  if (n === 'ARMS RACE STAGE A') return 'Arms Race Stage A';
  if (n === 'ARMS RACE STAGE B') return 'Arms Race Stage B';
  if (n === 'Shadowfront Squad 1') return 'Shadowfront - Squad 1';
  if (n === 'Shadowfront Squad 2') return 'Shadowfront - Squad 2';
  return n;
}

export function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/** Live HH:MM:SS until the deadline (hours not capped at 24). nowLabel once reached. */
export function formatCountdown(iso: string | null | undefined, nowLabel: string): string {
  const ms = new Date(iso as string).getTime() - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return nowLabel;
  const total = Math.floor(ms / 1000);
  return pad2(Math.floor(total / 3600)) + ':' +
    pad2(Math.floor((total % 3600) / 60)) + ':' +
    pad2(total % 60);
}

export function relativeTime(iso: string | null | undefined, nowLabel: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return nowLabel;
  if (diff < 3600) return Math.floor(diff / 60) + ' min';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' d';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}

export function formatBigNumber(n: number, fallback: (v: number) => string): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'k';
  return fallback(n);
}

export function getDefaultClocks(): ClockMember[] {
  return [];
}

export function parseTimezoneClocks(raw?: string | null): ClockMember[] {
  if (!raw) return getDefaultClocks();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ClockMember[]) : getDefaultClocks();
  } catch (_) {
    return getDefaultClocks();
  }
}

export function serializeTimezoneClocks(list: ClockMember[]): string {
  return JSON.stringify(list);
}
