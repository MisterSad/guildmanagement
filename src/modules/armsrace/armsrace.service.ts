/**
 * src/modules/armsrace/armsrace.service.ts
 *
 * Pure domain helpers for Arms Race (Stage A & Stage B), extracted from the
 * legacy root `armsrace.js`. No DOM, no globals.
 */

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
