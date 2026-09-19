/**
 * src/modules/overview/overview.service.ts
 *
 * Pure helpers extracted from the root `overview.js` (event-name prettifying,
 * countdown/relative-time formatting, big-number formatting, timezone-clock
 * persistence shape). No DOM, no globals.
 */

import { getTimezoneOffset } from '../../utils/timezone';

export interface ClockMember {
  name: string;
  offset: number;
  color: string;
  timezone?: string | null;
  role?: string | null;
}

export function buildOfficerClocks(
  members: Array<{
    pseudo: string;
    role?: string | null;
    timezone?: string | null;
    timezone_offset?: number | null;
  }>,
  date: Date = new Date()
): ClockMember[] {
  const officers = members.filter((m) => {
    const isOfficer = m.role === 'R5' || m.role === 'R4';
    const hasTz = !!m.timezone || (m.timezone_offset != null && !isNaN(Number(m.timezone_offset)));
    return isOfficer && hasTz;
  });

  const roleOrder: Record<string, number> = { R5: 0, R4: 1 };
  officers.sort((a, b) => {
    const roA = roleOrder[a.role || ''] ?? 99;
    const roB = roleOrder[b.role || ''] ?? 99;
    if (roA !== roB) return roA - roB;
    return a.pseudo.localeCompare(b.pseudo);
  });

  const colors = ['accent', 'warning', 'info', 'success', 'danger'];
  return officers.map((m, idx) => {
    const offset = m.timezone ? getTimezoneOffset(m.timezone, date) : Number(m.timezone_offset);
    const color = m.role === 'R5' ? 'warning' : colors[idx % colors.length];
    return {
      name: m.pseudo,
      offset,
      color,
      timezone: m.timezone || null,
      role: m.role || null
    };
  });
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
