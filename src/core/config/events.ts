/**
 * src/core/config/events.ts
 *
 * Single Source of Truth for event session ID building, ISO week keys,
 * date keys, and participation scoring keys across the application.
 */

import { GVG_DAILY_TASKS } from './gvg-daily-tasks';
import { newSessionId } from '../utils/date';

export function isoWeekKey(dateInput?: string | Date | null): string {
  let d: Date;
  if (!dateInput) d = new Date();
  else if (typeof dateInput === 'string') d = new Date(dateInput);
  else d = dateInput;

  if (isNaN(d.getTime())) d = new Date();

  // Force UTC to match the SQL to_char(..., 'IYYY-"W"IW').
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = utc.getUTCDay() || 7; // Mon=1 ... Sun=7
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const year = utc.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  const firstMon = new Date(firstThu.getTime() - ((firstThu.getUTCDay() || 7) - 1) * 86400000);
  const week = Math.floor((utc.getTime() - firstMon.getTime()) / 86400000 / 7) + 1;
  const isoYear = utc.getUTCFullYear();
  return `${isoYear}-W${week < 10 ? '0' : ''}${week}`;
}

export function dateKey(dateInput?: string | Date | null): string {
  let d: Date;
  if (!dateInput) d = new Date();
  else if (typeof dateInput === 'string') d = new Date(dateInput);
  else d = dateInput;

  if (isNaN(d.getTime())) d = new Date();

  const month = d.getUTCMonth() + 1;
  const date = d.getUTCDate();
  return `${d.getUTCFullYear()}${month < 10 ? '0' : ''}${month}${date < 10 ? '0' : ''}${date}`;
}

export function eventScoringKey(eventName?: string, sessionId?: string, weekStart?: string): string {
  const up = (eventName || '').toUpperCase();
  const ws = weekStart || '';
  if (up.indexOf('ARMS RACE') !== -1) return `Arms Race|${sessionId || ws}`;
  if (up === 'SHADOWFRONT') return `Shadowfront|${ws}`;
  if (up === 'SVS') return `SvS|${ws}`;
  if (up === 'GVG') return `GvG|${ws}`;
  if (up === 'DEFEND TRADE ROUTE') return `DTR|${sessionId || ws}`;
  return `${eventName || ''}|${sessionId || ws}`;
}

export function sessionDateFromId(sessionId?: string | null): Date | null {
  if (!sessionId) return null;
  const m = String(sessionId).match(/-(\d{4})(\d{2})(\d{2})(-\d+)?$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

export function buildEventSessionId(eventName?: string, startAt?: string | Date, existingIds?: string[]): string {
  const up = (eventName || '').toUpperCase();
  const ref = startAt || new Date();

  if (up === 'SVS') return 'SVS-' + isoWeekKey(ref);
  if (up === 'GVG') return 'GVG-' + isoWeekKey(ref);
  if (up === 'GLORY') return 'GLORY-' + isoWeekKey(ref);

  let base: string;
  if (up === 'ARMS RACE STAGE A') base = 'ARA-' + dateKey(ref);
  else if (up === 'ARMS RACE STAGE B') base = 'ARB-' + dateKey(ref);
  else if (up === 'DEFEND TRADE ROUTE') base = 'DTR-' + dateKey(ref);
  else if (up === 'SHADOWFRONT SQUAD 1') base = 'SF1-' + dateKey(ref);
  else if (up === 'SHADOWFRONT SQUAD 2') base = 'SF2-' + dateKey(ref);
  else return newSessionId();

  const ids = existingIds || [];
  let n = 1;
  while (ids.indexOf(`${base}-${n}`) !== -1) {
    n++;
  }
  return `${base}-${n}`;
}

export { GVG_DAILY_TASKS };
export { newSessionId } from '../utils/date';

/** Phosphor icon class for an event name. */
export function getEventIcon(name?: string | null): string {
  if (!name) return 'ph-calendar-dot';
  const lower = String(name).toLowerCase();
  if (lower.indexOf('svs') !== -1) return 'ph-swords';
  if (lower.indexOf('gvg') !== -1) return 'ph-flag-banner';
  if (lower.indexOf('shadowfront') !== -1) return 'ph-ghost';
  if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return 'ph-truck';
  if (lower.indexOf('stage a') !== -1) return 'ph-crosshair';
  if (lower.indexOf('stage b') !== -1) return 'ph-target';
  if (lower.indexOf('arms') !== -1 || lower.indexOf('race') !== -1) return 'ph-crosshair';
  if (lower.indexOf('glory') !== -1) return 'ph-trophy';
  if (lower.indexOf('sanction') !== -1) return 'ph-warning-octagon';
  return 'ph-calendar-dot';
}

/** Task-card theme class for an event name. */
export function getEventTheme(name?: string | null): string {
  if (!name) return 'gm-task-card-dark';
  const lower = String(name).toLowerCase();
  if (lower.indexOf('svs') !== -1) return 'gm-task-card-lime';
  if (lower.indexOf('gvg') !== -1) return 'gm-task-card-coral';
  if (lower.indexOf('shadowfront') !== -1) return 'gm-task-card-lilac';
  if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return 'gm-task-card-cyan';
  if (lower.indexOf('arms') !== -1 || lower.indexOf('race') !== -1) return 'gm-task-card-amber';
  if (lower.indexOf('glory') !== -1) return 'gm-task-card-mint';
  if (lower.indexOf('sanction') !== -1) return 'gm-task-card-lilac';
  return 'gm-task-card-dark';
}

/** Attendance rate against the larger of assigned vs attended opportunities. */
export function computeShadowfrontAttendanceRate(eventsDone?: number | null, assignedCount?: number | null): number {
  const done = eventsDone || 0;
  const assigned = assignedCount || 0;
  const opportunities = Math.max(assigned, done);
  return opportunities > 0 ? (done / opportunities) : 0;
}

/** Builds the Discord webhook payload for a given GvG day's task list. */
export function buildGvgDailyTaskEmbed(dayNumber: number, roleMention?: string): { content: string; embeds: any[] } {
  const mention = roleMention || '@everyone';
  const day = GVG_DAILY_TASKS[dayNumber] || GVG_DAILY_TASKS[1];

  const fields = day.categories.map((cat) => {
    const lines = cat.tasks.map((t) => '• ' + t.label + ': **`' + t.points + '`**').join('\n');
    return { name: cat.emoji + ' ' + cat.title, value: lines, inline: false };
  });

  const content = '📢 **GvG Day ' + day.dayNumber + ' Tasks are Live!** (' + day.dayName + ' · 00:01 UTC) ' + mention;

  const embed = {
    title: '⚔️ GvG Day ' + day.dayNumber + ' Tasks: ' + day.theme,
    description: 'Daily point breakdown & scoring priorities for **Guild vs Guild — Day ' + day.dayNumber + ' (' + day.dayName + ')**.\nCoordinate with your guild members and maximize points!',
    color: day.color,
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'FGF Guild Management Tool • GvG Daily Reminders (00:01 UTC)' }
  };

  return { content: content, embeds: [embed] };
}
