/**
 * src/modules/history/history.service.ts
 *
 * Pure helpers and constants for the Session History view, extracted verbatim
 * from the root `history.js` (event metadata, filters, session-date parsing,
 * secure editable-field whitelist).
 */

import { guildWrite } from '../../core/api/guild-rpc';
import type { DbClient } from '../../core/api/db-client';

export interface HistoryEventMeta {
  icon: string;
  label: string;
  filterKey: string;
  hasScore: boolean;
  border: string;
}

export interface HistorySession {
  event_name?: string;
  session_id?: string | null;
  week_start?: string | null;
  start_at?: string | null;
  display_name?: string;
  participants?: number;
  participated_count?: number;
  total_score?: number;
  [key: string]: unknown;
}

export const EVENT_META: Record<string, HistoryEventMeta> = {
  'SvS':                { icon: 'ph-sword',      label: 'SvS',         filterKey: 'SvS',         hasScore: true,  border: 'var(--accent)' },
  'GvG':                { icon: 'ph-flag-banner', label: 'GvG',         filterKey: 'GvG',         hasScore: true,  border: 'var(--accent)' },
  'Shadowfront':        { icon: 'ph-ghost',       label: 'Shadowfront', filterKey: 'Shadowfront', hasScore: false, border: 'var(--info)'   },
  'Defend Trade Route': { icon: 'ph-truck',       label: 'DTR',         filterKey: 'DTR',         hasScore: false, border: 'var(--info)'   },
  'ARMS RACE STAGE A':  { icon: 'ph-crosshair',   label: 'Arms Race A', filterKey: 'Arms Race',   hasScore: false, border: 'var(--warning)'},
  'ARMS RACE STAGE B':  { icon: 'ph-target',      label: 'Arms Race B', filterKey: 'Arms Race',   hasScore: false, border: 'var(--warning)'},
  'Glory':              { icon: 'ph-trophy',      label: 'Glory',       filterKey: 'Glory',       hasScore: true,  border: 'var(--success)'}
};

export const FILTERS = ['All', 'SvS', 'GvG', 'Shadowfront', 'DTR', 'Arms Race', 'Glory'];

/** Secure whitelist: only these participant fields may be edited from History. */
export const ALLOWED_HISTORY_FIELDS = [
  'participated', 'score', 'score_prep', 'score_pvp',
  'late', 'excused', 'sub_present', 'appointed', 'is_pending'
];

export const HISTORY_CACHE_TTL_MS = 15000;

export function isAllowedHistoryField(field: string): boolean {
  return ALLOWED_HISTORY_FIELDS.indexOf(field) !== -1;
}

// session_id is a human-readable key (ARA-20260809, SF1-20260802, SVS-2026-W32,
// ...). A trailing YYYYMMDD segment (or a week key) stands in for the date.
export function hasSessionDate(sessionId?: string | null): boolean {
  if (!sessionId) return false;
  return /-\d{8}(-\d+)?$/.test(sessionId) || /-\d{4}-W\d{2}$/.test(sessionId);
}

export function parseSessionDate(s: HistorySession): Date | null {
  let d: Date | null = null;
  if (s.start_at) {
    const raw = String(s.start_at);
    // Postgres can serialize timestamptz as "2026-08-12T19:30:00+00" (offset
    // without minutes), which JS Date rejects. Normalize it.
    d = new Date(raw.replace(/\+00$/, '+00:00'));
    if (isNaN(d.getTime())) d = new Date(raw);
    if (isNaN(d.getTime())) d = null;
  }
  if (!d || isNaN(d.getTime())) {
    const sid = s.session_id || '';
    const m = sid.match(/-(\d{4})(\d{2})(\d{2})(-\d+)?$/);
    if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    else if (s.week_start) d = new Date(s.week_start + 'T12:00:00Z');
  }
  return d && !isNaN(d.getTime()) ? d : null;
}

export function sessionTime(s: HistorySession): number {
  const d = parseSessionDate(s);
  return d && !isNaN(d.getTime()) ? d.getTime() : 0;
}

export function formatSessionDate(sessionId: string): string {
  const m = sessionId.match(/-(\d{4})(\d{2})(\d{2})(-\d+)?$/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  }
  return sessionId;
}

export function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

export function getWeekNumber(ws?: string | null): number | string {
  if (!ws) return '';
  const d = new Date(ws.length === 10 ? ws + 'T12:00:00Z' : ws);
  if (isNaN(d.getTime())) return '';
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

export function getCategoryEventNames(filterKey: string): string[] {
  if (filterKey === 'SvS') return ['SvS'];
  if (filterKey === 'GvG') return ['GvG'];
  if (filterKey === 'Shadowfront') return ['Shadowfront', 'Shadowfront Squad 1', 'Shadowfront Squad 2'];
  if (filterKey === 'DTR') return ['Defend Trade Route'];
  if (filterKey === 'Arms Race') return ['ARMS RACE STAGE A', 'ARMS RACE STAGE B'];
  if (filterKey === 'Glory') return ['Glory'];
  return [filterKey];
}

export function filterSessions(sessions: HistorySession[], activeFilter: string): HistorySession[] {
  return sessions.filter((s) => {
    if (activeFilter === 'All') return true;
    const meta = EVENT_META[s.event_name || ''];
    return !!meta && meta.filterKey === activeFilter;
  });
}

export function sortSessionsDesc(sessions: HistorySession[]): HistorySession[] {
  return sessions.slice().sort((a, b) => sessionTime(b) - sessionTime(a));
}

/**
 * Clears a category's history in one transaction. Sessions still running --
 * their participants, status and squads -- and squads not yet started are
 * kept (owner decision, 2026-10-03). Throws on refusal.
 */
export function clearEventHistory(eventNames: string[]): Promise<{ ok: true; participants: number; sessions: number; spared: number }> {
  return guildWrite('gm_clear_event_history', { p_event_names: eventNames });
}

/** Deletes one session of the History detail dialog in one transaction. Throws on refusal. */
export function deleteHistorySession(eventName: string, weekStart: string, sessionId: string | null): Promise<{ ok: true; participants: number }> {
  return guildWrite('gm_delete_history_session', { p_event_name: eventName, p_week_start: weekStart, p_session_id: sessionId });
}

// ── Data access (M4b) ─────────────────────────────────────────────────────────
// Each builder takes the client the view hands it and returns the
// builder/promise; the view awaits it and keeps its own error handling.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** List the guild's event sessions through `gm_list_event_sessions`. */
export function listEventSessions(db: DbClient, guild: string | null) {
  return db.rpc('gm_list_event_sessions', { p_guild: guild });
}

/** List the guild's war sessions (all war events) through `gm_list_war_sessions`. */
export function listAllWarSessions(db: DbClient, guild: string | null) {
  return db.rpc('gm_list_war_sessions', { p_guild: guild, p_event_name: '' });
}

/** Read every Glory participant row of the guild. */
export function fetchGloryParticipantRows(db: DbClient, guild: string | null) {
  return db.from('event_participants')
    .select('pseudo, week_start, participated, score, session_id')
    .eq('guild', guild)
    .eq('event_name', 'Glory');
}

/** Read one session's participant rows for the History detail dialog. */
export function fetchSessionParticipants(db: DbClient, guild: string | null, eventName: string, weekStart: string, sessionId: string | null) {
  let query: any = db.from('event_participants')
    .select('pseudo, participated, score, score_prep, score_pvp, appointed, excused, late, sub_present')
    .eq('guild', guild)
    .eq('event_name', eventName)
    .eq('week_start', weekStart);

  if (sessionId) query = query.eq('session_id', sessionId);
  else query = query.is('session_id', null);
  return query;
}

/** Update one whitelisted field of a participant row in a session. The caller enforces the whitelist. */
export function updateSessionParticipantField(db: DbClient, guild: string | null, eventName: string, weekStart: string, sessionId: string | null, pseudo: string, field: string, value: unknown) {
  let query: any = db.from('event_participants')
    .update({ [field]: value })
    .eq('guild', guild)
    .eq('event_name', eventName)
    .eq('week_start', weekStart)
    .eq('pseudo', pseudo);
  if (sessionId) query = query.eq('session_id', sessionId);
  else query = query.is('session_id', null);
  return query;
}
