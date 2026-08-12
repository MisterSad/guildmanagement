/**
 * src/core/config/events.ts
 *
 * Single Source of Truth for event session ID building, ISO week keys,
 * date keys, and participation scoring keys across the application.
 */

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
  else return 'SESS-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);

  const ids = existingIds || [];
  let n = 1;
  while (ids.indexOf(`${base}-${n}`) !== -1) {
    n++;
  }
  return `${base}-${n}`;
}
