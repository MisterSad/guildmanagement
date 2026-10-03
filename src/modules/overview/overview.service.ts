/**
 * src/modules/overview/overview.service.ts
 *
 * Pure helpers extracted from the root `overview.js` (event-name prettifying,
 * countdown/relative-time formatting, big-number formatting, timezone-clock
 * persistence shape). No DOM, no globals.
 */

import { getTimezoneOffset } from '../../utils/timezone';
import { webhookChainIsSet } from '../../core/integrations/discord';
import type { DbClient } from '../../core/api/db-client';

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

/**
 * Whether the guild can receive any Discord reminder at all, from the list of
 * webhook keys `gm_configured_webhooks` says are set (ARC-04: never the URLs).
 * Measured on 2026-09-30: 17 of 31 guilds had no webhook anywhere, so no
 * reminder could reach them whatever their toggles said -- and nothing in the
 * app told them.
 */
export function hasDiscordWebhook(configured: string[] | null | undefined): boolean {
  return webhookChainIsSet(configured);
}

// ---------------------------------------------------------------------------
// Queries (M4b). Each returns the builder; the view awaits it.
// ---------------------------------------------------------------------------

/** Head-only count of the guild's members (the caller adds the guild filter). */
export function queryMemberCount(db: DbClient) {
  return db.from('guild_members').select('id', { count: 'exact', head: true });
}

/** Event status rows (the caller adds the guild filter). */
export function queryEventStatus(db: DbClient) {
  return db.from('event_status').select('event_name, is_active, updated_at, session_id, start_at');
}

/** Glory scores of one week (the caller adds the guild filter). */
export function queryGloryScores(db: DbClient, weekStart: string) {
  return db.from('event_participants').select('pseudo, score').eq('event_name', 'Glory').eq('week_start', weekStart);
}

/** The five most recent sanctions (the caller adds the guild filter). */
export function queryRecentSanctions(db: DbClient) {
  return db.from('sanctions').select('id, pseudo, comment, created_by, created_at').order('created_at', { ascending: false }).limit(5);
}

/** The five most recently added members (the caller adds the guild filter). */
export function queryRecentMembers(db: DbClient) {
  return db.from('guild_members').select('pseudo, created_at').order('created_at', { ascending: false }).limit(5);
}

/** The five latest approved transfers into or out of the guild. */
export function queryRecentTransfers(db: DbClient, currentG: string | null) {
  return db.from('guild_transfers').select('pseudo, source_guild, target_guild, resolved_at').eq('status', 'approved').or('source_guild.eq.' + currentG + ',target_guild.eq.' + currentG).order('resolved_at', { ascending: false }).limit(5);
}

/** Every member's overall power (the caller adds the guild filter). */
export function queryMemberPower(db: DbClient) {
  return db.from('guild_members').select('overall_power');
}

/** Members' role and timezone, for the officer clocks (the caller adds the guild filter). */
export function queryOfficerTimezones(db: DbClient) {
  return db.from('guild_members').select('pseudo, role, timezone, timezone_offset');
}

/** Members' role and timezone of one guild, for the "sync with officers" button. */
export function queryGuildOfficerTimezones(db: DbClient, currentG: string | null) {
  return db.from('guild_members').select('pseudo, role, timezone, timezone_offset').eq('guild', currentG);
}

/** The webhook keys configured for a guild (never the URLs). */
export function fetchConfiguredWebhooks(db: DbClient, guild: string) {
  return db.rpc('gm_configured_webhooks', { p_guild: guild });
}
