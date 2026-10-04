/**
 * src/core/utils/date.ts
 *
 * Pure UTC date manipulation, ISO week parsing, and date formatting utilities.
 * Extracted from gm-utils.js as part of Ticket 3.2 modularization.
 */
import { getLang } from '../i18n/i18n';

export function pad2(n: number | string): string {
  return String(n).padStart(2, '0');
}

/**
 * Returns Monday at 00:00 UTC for the given date (or current date if omitted).
 * Formatted as YYYY-MM-DD.
 */
export function getWeekStart(date?: string | Date | number | null): string {
  const d = date ? new Date(date) : new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat (UTC)
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

/**
 * Returns previous week's Monday in YYYY-MM-DD format.
 */
export function getPrevWeekStart(weekStr?: string | null): string {
  const base = weekStr ? new Date(weekStr + 'T12:00:00Z') : new Date(getWeekStart() + 'T12:00:00Z');
  base.setUTCDate(base.getUTCDate() - 7);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}`;
}

/**
 * Formats a week start string (YYYY-MM-DD) into human-readable range: "DD/MM → DD/MM/YYYY".
 */
export function formatWeek(ws?: string | null): string {
  if (!ws) return '';
  const d = new Date(ws.length === 10 ? ws + 'T12:00:00Z' : ws);
  if (isNaN(d.getTime())) return String(ws || '');
  const end = new Date(d);
  end.setUTCDate(end.getUTCDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', timeZone: 'UTC' };
  const endOpts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' };
  return `${d.toLocaleDateString('en-GB', opts)} → ${end.toLocaleDateString('en-GB', endOpts)}`;
}

/**
 * Creates an ISO timestamp session ID.
 */
export function newSessionId(): string {
  return new Date().toISOString();
}

export interface DateHolder {
  week_start?: string | null;
  battle_date?: string | null;
  start_at?: string | null;
  date?: string | null;
  session_id?: string | null;
  [key: string]: unknown;
}

/**
 * Formats a session/week identifier (ISO week, YYYYMMDD, YYYY-MM-DD, or raw JS date) as DD/MM/YY.
 */
export function formatChartDate(h?: string | DateHolder | null): string {
  if (!h) return '';
  const raw = typeof h === 'string' ? h : h.week_start || h.battle_date || h.start_at || h.date || h.session_id || '';
  if (!raw) return '';

  // 1. Direct YYYY-MM-DD pattern (e.g. 2026-08-10 or 2026-08-10T...)
  const ymdMatch = String(raw).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (ymdMatch) {
    const y = ymdMatch[1].slice(-2);
    const m = ymdMatch[2];
    const d = ymdMatch[3];
    return `${d}/${m}/${y}`;
  }

  // 2. YYYYMMDD compact pattern (e.g. ARA-20260815, SF-20260815, DTR-20260815)
  const compactMatch = String(raw).match(/(\d{4})(\d{2})(\d{2})/);
  if (compactMatch) {
    const cy = compactMatch[1].slice(-2);
    const cm = compactMatch[2];
    const cd = compactMatch[3];
    return `${cd}/${cm}/${cy}`;
  }

  // 3. ISO Week pattern (e.g. SVS-2026-W33, GVG-2026-W33, 2026-W33)
  const weekMatch = String(raw).match(/(\d{4})-W(\d{2})/i);
  if (weekMatch) {
    const yr = parseInt(weekMatch[1], 10);
    const wk = parseInt(weekMatch[2], 10);
    const simple = new Date(Date.UTC(yr, 0, 1 + (wk - 1) * 7));
    const dayOfWeek = simple.getUTCDay();
    const isoMonday = new Date(simple);
    if (dayOfWeek <= 4) {
      isoMonday.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
    } else {
      isoMonday.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
    }
    return `${pad2(isoMonday.getUTCDate())}/${pad2(isoMonday.getUTCMonth() + 1)}/${String(isoMonday.getUTCFullYear()).slice(-2)}`;
  }

  // 4. Fallback: try JS Date parsing
  const dt = new Date(raw);
  if (!isNaN(dt.getTime())) {
    return `${pad2(dt.getUTCDate())}/${pad2(dt.getUTCMonth() + 1)}/${String(dt.getUTCFullYear()).slice(-2)}`;
  }

  return String(raw);
}

/**
 * Formats an ISO timestamp as a short UTC wall-clock label,
 * e.g. "ven. 17/05 · 20:00 UTC". Locale follows the i18n language.
 */
export function formatDateTimeUTC(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
  const date = d.toLocaleDateString(locale, { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  return date + ' · ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' UTC';
}
