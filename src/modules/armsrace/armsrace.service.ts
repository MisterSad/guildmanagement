/**
 * src/modules/armsrace/armsrace.service.ts
 *
 * Pure domain helpers for Arms Race (Stage A & Stage B), extracted from the
 * legacy root `armsrace.js`. No DOM, no globals.
 *
 * Data access (M4b): the query builders at the bottom take the client the view
 * hands them and return the builder/promise; the view awaits it and keeps its
 * own error handling.
 */

import type { DbClient } from '../../core/api/db-client';

/**
 * Real `event_status` / `event_participants` event_name values (verbatim from
 * armsrace.js). Note: `armsrace_sa` / `armsrace_sb` are OCR metric keys and
 * must NOT be used here.
 */
export const ARMSRACE_STAGE_EVENTS = {
  stageA: 'ARMS RACE STAGE A',
  stageB: 'ARMS RACE STAGE B'
} as const;

export type ArmsRaceStageKey = keyof typeof ARMSRACE_STAGE_EVENTS;

export const ARMSRACE_STAGE_KEYS: ArmsRaceStageKey[] = ['stageA', 'stageB'];

export interface ArmsRaceParticipantRow {
  pseudo?: string;
  event_name?: string;
  session_id?: string | null;
  week_start?: string | null;
  participated?: number | string | null;
  score?: number | string | null;
  uid?: string | null;
  [key: string]: unknown;
}

export interface ArmsRaceStageState {
  active: boolean;
  sessionId: string | null;
  startAt: string | null;
  participants: ArmsRaceParticipantRow[];
}

export interface ArmsRaceRpcParams {
  p_event_name: string;
  p_session_id: string;
  p_week_start: string;
  p_guild: string;
}

export function armsRaceStageLabel(stageKey: ArmsRaceStageKey): string {
  return stageKey === 'stageA' ? 'Stage A' : 'Stage B';
}

export function armsRaceStageLetter(stageKey: ArmsRaceStageKey): 'A' | 'B' {
  return stageKey === 'stageA' ? 'A' : 'B';
}

/** Filter the raw participant rows down to one event + session (port of the inline filter). */
export function filterStageParticipants(
  rows: ArmsRaceParticipantRow[],
  eventName: string,
  sessionId: string | null
): ArmsRaceParticipantRow[] {
  return rows.filter((p) => p.event_name === eventName && p.session_id === sessionId);
}

/** Stable pseudo sort used after in-memory member injection. */
export function sortArmsRaceParticipants<T extends { pseudo?: string }>(list: T[]): T[] {
  return list.slice().sort((a, b) => String(a.pseudo).localeCompare(String(b.pseudo)));
}

/** Payload for the `gm_populate_event_participants` RPC. */
export function buildPopulateParams(
  stageKey: ArmsRaceStageKey,
  sessionId: string,
  weekStart: string,
  guild: string
): ArmsRaceRpcParams {
  return {
    p_event_name: ARMSRACE_STAGE_EVENTS[stageKey],
    p_session_id: sessionId,
    p_week_start: weekStart,
    p_guild: guild
  };
}

/** Participation counters used by the header chips. */
export function computeArmsRaceStats(participants: ArmsRaceParticipantRow[]): { total: number; done: number; absent: number } {
  const total = participants.length;
  const done = participants.reduce((acc, p) => acc + (Number(p.participated) || 0), 0);
  return { total, done, absent: total - done };
}

// ── Data access (M4b) ─────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Read both stages' `event_status` rows for a guild. */
export function fetchArmsRaceStatus(db: DbClient, guild: string | null) {
  let statusQ: any = db.from('event_status').select('event_name, is_active, session_id, start_at')
    .in('event_name', [ARMSRACE_STAGE_EVENTS.stageA, ARMSRACE_STAGE_EVENTS.stageB]);
  statusQ = statusQ.eq('guild', guild);
  return statusQ;
}

/** Read the guild's member pseudos and UIDs. */
export function fetchArmsRaceMembers(db: DbClient, guild: string | null) {
  let membersQ: any = db.from('guild_members').select('pseudo, uid');
  membersQ = membersQ.eq('guild', guild);
  return membersQ;
}

/** Read the participants of both stages for the given session ids. */
export function fetchArmsRaceParticipants(db: DbClient, guild: string | null, sessionIds: string[]) {
  return db.from('event_participants').select('*')
    .eq('guild', guild)
    .in('event_name', [ARMSRACE_STAGE_EVENTS.stageA, ARMSRACE_STAGE_EVENTS.stageB])
    .in('session_id', sessionIds)
    .order('pseudo', { ascending: true });
}

/** Read the participants of one stage session. */
export function fetchStageParticipants(db: DbClient, guild: string | null, eventName: string, sessionId: string | null) {
  return db.from('event_participants').select('*')
    .eq('guild', guild)
    .eq('event_name', eventName)
    .eq('session_id', sessionId)
    .order('pseudo', { ascending: true });
}

/** Enrol the guild's members into a stage session through `gm_populate_event_participants`. */
export function populateStageParticipants(db: DbClient, stageKey: ArmsRaceStageKey, sessionId: string, weekStart: string, guild: string) {
  return db.rpc('gm_populate_event_participants', buildPopulateParams(stageKey, sessionId, weekStart, guild));
}

/** Upsert a stage's `event_status` row (start or end). */
export function upsertStageStatus(db: DbClient, row: Record<string, unknown>) {
  return db.from('event_status').upsert(
    row,
    { onConflict: 'guild,event_name' }
  );
}

/** Read a stage's scheduled start. */
export function fetchStageStartAt(db: DbClient, guild: string | null, eventName: string) {
  return db.from('event_status').select('start_at')
    .eq('guild', guild)
    .eq('event_name', eventName).maybeSingle();
}

/** Set one participant's participation flag in a stage session. */
export function updateStageParticipation(db: DbClient, guild: string | null, eventName: string, sessionId: string | null, pseudo: string, value: number) {
  return db.from('event_participants').update({ participated: value })
    .eq('guild', guild)
    .eq('event_name', eventName)
    .eq('session_id', sessionId)
    .eq('pseudo', pseudo);
}
