/**
 * src/modules/stats/stats.service.ts
 *
 * Pure leaderboard computation for the Stats page: weighted scoring, attendance
 * rates and per-event aggregation. No DOM, no I/O.
 */

import { eventScoringKey } from '../../core/config/events';


// ParticipationRecord, PeriodFilter, filterRecordsByPeriod(),
// calculateDistinctAttendanceRate(), calculateMemberAttendanceRate() and
// generateCSVReport() were removed on 2026-09-27. All four methods had zero
// callers in src/, tests/ and e2e/ -- only the GM.services.stats bridge
// nominally exposed them -- and the two types existed solely to type them.
//
// calculateDistinctAttendanceRate() is worth a note: it implemented the
// distinct-scoring-key attendance rate correctly, and that same algorithm is
// live in Deno at supabase/functions/member-portal/index.ts (the badge count).
// One idea, two languages, and the TypeScript copy was the dead one.

export class StatsService {
  public static computeWeightedLeaderboard(
    params: WeightedLeaderboardParams
  ): WeightedLeaderboardResult {
    const { membersList, partRows, gloryRows, weeks } = params;
    const coeffs: EventCoeffs = params.coeffs || DEFAULT_EVENT_COEFFS;

    const gloryByWeek: Record<string, Record<string, number>> = {};
    weeks.forEach((w) => { gloryByWeek[w] = {}; });
    gloryRows.forEach((r) => {
      const ws = r.week_start || '';
      if (!gloryByWeek[ws]) gloryByWeek[ws] = {};
      gloryByWeek[ws][normalizePseudo(r.pseudo)] = Number(r.score) || 0;
    });

    const weekStarts = Object.keys(gloryByWeek).sort();
    const gloryDeltas: Record<string, number> = {};
    membersList.forEach((pseudo) => {
      const norm = normalizePseudo(pseudo);
      const playerWeeks = weekStarts.filter((w) => (gloryByWeek[w][norm] || 0) > 0);
      // Sum every positive week-on-week gain. The loop used to start at j = 1
      // and stop at length - 2, which silently discarded BOTH the first
      // transition and the last one: with two scoring weeks the delta was
      // always 0, and with three only the middle pair counted. Glory is the
      // one metric with 78.9% score coverage, so this was throwing away the
      // best-populated signal on the page.
      let totalDelta = 0;
      for (let j = 0; j < playerWeeks.length - 1; j++) {
        const prev = gloryByWeek[playerWeeks[j]][norm] || 0;
        const curr = gloryByWeek[playerWeeks[j + 1]][norm] || 0;
        const diff = curr - prev;
        if (diff > 0) totalDelta += diff;
      }
      gloryDeltas[pseudo] = totalDelta;
    });
    const maxGloryDelta = Math.max(...Object.values(gloryDeltas).concat([0]));

    const aggMap: Record<string, { eventsScore: number; eventsAttended: number; eventsTotal: number }> = {};
    membersList.forEach((pseudo) => { aggMap[pseudo] = { eventsScore: 0, eventsAttended: 0, eventsTotal: 0 }; });

    const validPartRows = partRows.filter((p) => !p.is_pending);

    const tenantEventInstances = new Set<string>();
    validPartRows.forEach((p) => {
      if ((p.event_name || '').toLowerCase() === 'glory') return;
      const evKey = eventScoringKey(p.event_name, p.session_id || undefined, p.week_start);
      if (evKey) tenantEventInstances.add(evKey);
    });
    const totalTenantEvents = tenantEventInstances.size;

    const attendedSessionsByMember: Record<string, Set<string>> = {};
    membersList.forEach((pseudo) => { attendedSessionsByMember[normalizePseudo(pseudo)] = new Set<string>(); });

    validPartRows.forEach((p) => {
      if ((p.event_name || '').toLowerCase() === 'glory') return;
      const norm = normalizePseudo(p.pseudo);
      const memberMatch = membersList.find((m) => normalizePseudo(m) === norm);
      if (!memberMatch) return;

      const agg = aggMap[memberMatch];
      const evName = (p.event_name || '').trim();
      const coeffBucket = resolveCoeffBucket(evName);
      const coeff = (coeffBucket && coeffs[coeffBucket] != null) ? coeffs[coeffBucket] : 1;
      const evKey = eventScoringKey(evName, p.session_id || undefined, p.week_start);

      const attended =
        Number(p.participated) > 0 ||
        p.sub_present === true ||
        Number(p.score) > 0 ||
        Number(p.score_prep) > 0 ||
        Number(p.score_pvp) > 0;

      if (attended && !attendedSessionsByMember[norm].has(evKey)) {
        attendedSessionsByMember[norm].add(evKey);
        agg.eventsAttended++;

        const baseScore = STATS_WEIGHTS.participation * coeff;
        let perfScore = 0;

        if (evName === 'SvS' || evName === 'GvG') {
          const rawSc = (Number(p.score) || 0) + (Number(p.score_prep) || 0) + (Number(p.score_pvp) || 0);
          perfScore = rawSc > 0 ? (STATS_WEIGHTS.performance * coeff) : 0;
        }

        agg.eventsScore += (baseScore + perfScore);
      }
    });

    membersList.forEach((pseudo) => {
      if (aggMap[pseudo]) aggMap[pseudo].eventsTotal = totalTenantEvents;
    });

    const scores = membersList.map((pseudo) => {
      const agg = aggMap[pseudo] || { eventsScore: 0, eventsAttended: 0, eventsTotal: 0 };
      const attRate = agg.eventsTotal > 0 ? agg.eventsAttended / agg.eventsTotal : 0;
      const consistencyBonus = attRate >= STATS_WEIGHTS.threshold ? (STATS_WEIGHTS.consistency * Math.max(1, weeks.length)) : 0;
      const delta = gloryDeltas[pseudo] || 0;
      const gloryBonus = (delta > 0 && maxGloryDelta > 0) ? (delta / maxGloryDelta) * STATS_WEIGHTS.gloryMax * Math.max(1, weeks.length) : 0;
      const totalScore = agg.eventsScore + gloryBonus + consistencyBonus;

      return {
        pseudo,
        score: round1(totalScore),
        events_score: round1(agg.eventsScore),
        events_done: agg.eventsAttended,
        events_total: agg.eventsTotal,
        attendance_rate: attRate,
        glory_delta: delta,
        glory_bonus: round1(gloryBonus),
        consistency_bonus: consistencyBonus
      };
    }).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.pseudo.localeCompare(b.pseudo);
    });

    const maxPossibleScore = round1((STATS_WEIGHTS.participation + STATS_WEIGHTS.performance + STATS_WEIGHTS.gloryMax + STATS_WEIGHTS.consistency) * Math.max(1, weeks.length) * 5);
    return { scores, maxPossible: maxPossibleScore };
  }

  /**
   * Pure attendance-rate leaderboard (Stats "Attendance Rate" mode).
   * Ported verbatim from stats.js#loadParticipationMode's aggregation step.
   */
  public static computeParticipationLeaderboard(
    params: ParticipationLeaderboardParams
  ): ParticipationScoreRow[] {
    const { membersList, validRows } = params;

    const tenantEventInstances = new Set<string>();
    validRows.forEach((r) => {
      if ((r.event_name || '').toLowerCase() === 'glory') return;
      const evKey = eventScoringKey(r.event_name, r.session_id || undefined, r.week_start);
      if (evKey) tenantEventInstances.add(evKey);
    });
    const totalTenantEvents = tenantEventInstances.size;

    const attendedSessionsByMember: Record<string, Set<string>> = {};
    membersList.forEach((m) => { attendedSessionsByMember[normalizePseudo(m)] = new Set<string>(); });

    validRows.forEach((r) => {
      if ((r.event_name || '').toLowerCase() === 'glory') return;
      const norm = normalizePseudo(r.pseudo);
      if (attendedSessionsByMember[norm]) {
        const evKey = eventScoringKey(r.event_name, r.session_id || undefined, r.week_start);
        if (Number(r.participated) > 0 || r.sub_present === true) {
          attendedSessionsByMember[norm].add(evKey);
        }
      }
    });

    return membersList.map((pseudo) => {
      const norm = normalizePseudo(pseudo);
      const attendedCount = attendedSessionsByMember[norm] ? attendedSessionsByMember[norm].size : 0;
      const rate = totalTenantEvents > 0 ? attendedCount / totalTenantEvents : 0;
      return {
        pseudo,
        score: round1(rate * 100),
        events_done: attendedCount,
        events_total: totalTenantEvents,
        attendance_rate: rate,
        glory_delta: 0,
        glory_bonus: 0,
        consistency_bonus: 0
      };
    }).sort((a, b) => b.score - a.score);
  }

  /**
   * Per-event leaderboard (SvS/GvG/Shadowfront/Arms Race/DTR/Glory).
   * Ported verbatim from stats.js#loadSingleEventMode's aggregation step,
   * including Shadowfront squad breakdown and attendance-rate capping.
   */
  public static computeEventLeaderboard(params: EventLeaderboardParams): EventScoreRow[] {
    const { eventName, rows, allSquads, rosterMembers, shadowfrontRate } = params;

    const byMember: Record<string, ByMemberAcc> = {};
    const squadCounts: Record<string, number> = {};
    const participantCounts: Record<string, number> = {};
    const reserveCounts: Record<string, number> = {};
    const squad1Counts: Record<string, number> = {};
    const squad2Counts: Record<string, number> = {};
    const commanderCounts: Record<string, number> = {};

    if (eventName === 'Shadowfront') {
      allSquads.forEach((sq) => {
        const norm = normalizePseudo(sq.pseudo);
        squadCounts[norm] = (squadCounts[norm] || 0) + 1;
        if ((sq.role || '').toLowerCase() === 'reserve') {
          reserveCounts[norm] = (reserveCounts[norm] || 0) + 1;
        } else {
          participantCounts[norm] = (participantCounts[norm] || 0) + 1;
        }
        if (sq.squad === 'squad1') {
          squad1Counts[norm] = (squad1Counts[norm] || 0) + 1;
        } else if (sq.squad === 'squad2') {
          squad2Counts[norm] = (squad2Counts[norm] || 0) + 1;
        }
        if (sq.is_commander) {
          commanderCounts[norm] = (commanderCounts[norm] || 0) + 1;
        }
      });
    }

    rows.forEach((r) => {
      const norm = normalizePseudo(r.pseudo);
      if (!byMember[norm]) {
        byMember[norm] = emptyByMemberAcc(r.pseudo || '');
      }
      const prep = Number(r.score_prep) || 0;
      const pvp = Number(r.score_pvp) || 0;
      const sc = Number(r.score) || 0;
      const tot = sc > 0 ? sc : (prep + pvp);
      byMember[norm].score_prep += prep;
      byMember[norm].score_pvp += pvp;
      byMember[norm].score += tot;

      const attended = Number(r.participated) > 0 || r.sub_present === true || prep > 0 || pvp > 0 || sc > 0;
      if (attended) {
        byMember[norm].events_done += 1;
      }
      if (r.sub_present === true) {
        byMember[norm].sub_count += 1;
      }
      if (r.late === true) {
        byMember[norm].late_count += 1;
      }
      if (r.excused === true) {
        byMember[norm].excused_count += 1;
      }

      const evLower = (r.event_name || '').toLowerCase();
      const sessionId = r.session_id || '';
      if (evLower.indexOf('stage a') !== -1 || String(sessionId).indexOf('ARA-') !== -1) {
        if (attended) byMember[norm].ara_count += 1;
      }
      if (evLower.indexOf('stage b') !== -1 || String(sessionId).indexOf('ARB-') !== -1) {
        if (attended) byMember[norm].arb_count += 1;
      }
      byMember[norm].events_total += 1;
    });

    rosterMembers.forEach((gm) => {
      const norm = normalizePseudo(gm.pseudo);
      if (!byMember[norm]) {
        byMember[norm] = emptyByMemberAcc(gm.pseudo || '');
      }
    });

    return Object.values(byMember).map((m) => {
      const norm = normalizePseudo(m.pseudo);
      const assignedCount = squadCounts[norm] || 0;
      let rate = 0;
      if (eventName === 'Shadowfront') {
        rate = shadowfrontRate(m.events_done, assignedCount);
      } else {
        rate = m.events_total > 0 ? (m.events_done / m.events_total) : 0;
      }

      return {
        pseudo: m.pseudo,
        score: m.score,
        score_prep: m.score_prep,
        score_pvp: m.score_pvp,
        events_done: m.events_done,
        events_total: m.events_total,
        sub_count: m.sub_count,
        assigned_count: assignedCount,
        participant_count: participantCounts[norm] || 0,
        reserve_count: reserveCounts[norm] || 0,
        squad1_count: squad1Counts[norm] || 0,
        squad2_count: squad2Counts[norm] || 0,
        commander_count: commanderCounts[norm] || 0,
        ara_count: m.ara_count,
        arb_count: m.arb_count,
        late_count: m.late_count,
        excused_count: m.excused_count,
        attendance_rate: rate,
        glory_delta: 0,
        glory_bonus: 0,
        consistency_bonus: 0
      };
    }).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.events_done !== a.events_done) return b.events_done - a.events_done;
      if (b.attendance_rate !== a.attendance_rate) return b.attendance_rate - a.attendance_rate;
      return a.pseudo.localeCompare(b.pseudo);
    });
  }
}

// ── Shared types & pure helpers (Stats calculation core) ──────────────────────

// B1: declared once in core/config/event-coeffs and re-exported here, so the
// stats engine and the settings screen cannot weight events differently.
import {
  DEFAULT_EVENT_COEFFS,
  type EventCoeffBucket,
  type EventCoeffs
} from '../../core/config/event-coeffs';

export { DEFAULT_EVENT_COEFFS };
export type { EventCoeffBucket, EventCoeffs };

export const STATS_WEIGHTS = {
  participation: 6,
  performance: 4,
  gloryMax: 20,
  consistency: 15,
  threshold: 0.8
} as const;

export interface ParticipantRow {
  pseudo?: string;
  event_name?: string;
  session_id?: string | null;
  week_start?: string;
  participated?: number | string | null;
  score?: number | string | null;
  score_prep?: number | string | null;
  score_pvp?: number | string | null;
  is_pending?: boolean;
  sub_present?: boolean;
  late?: boolean;
  excused?: boolean;
  [key: string]: unknown;
}

export interface MemberRow {
  pseudo?: string;
  uid?: string;
  [key: string]: unknown;
}

export interface SquadRow {
  pseudo?: string;
  role?: string;
  squad?: string;
  is_commander?: boolean;
  week_start?: string;
  [key: string]: unknown;
}

export interface WeightedScoreRow {
  pseudo: string;
  score: number;
  events_score: number;
  events_done: number;
  events_total: number;
  attendance_rate: number;
  glory_delta: number;
  glory_bonus: number;
  consistency_bonus: number;
}

export interface ParticipationScoreRow {
  pseudo: string;
  score: number;
  events_done: number;
  events_total: number;
  attendance_rate: number;
  glory_delta: number;
  glory_bonus: number;
  consistency_bonus: number;
}

export interface EventScoreRow {
  pseudo: string;
  score: number;
  score_prep: number;
  score_pvp: number;
  events_done: number;
  events_total: number;
  sub_count: number;
  assigned_count: number;
  participant_count: number;
  reserve_count: number;
  squad1_count: number;
  squad2_count: number;
  commander_count: number;
  ara_count: number;
  arb_count: number;
  late_count: number;
  excused_count: number;
  attendance_rate: number;
  glory_delta: number;
  glory_bonus: number;
  consistency_bonus: number;
}

export interface WeightedLeaderboardParams {
  membersList: string[];
  partRows: ParticipantRow[];
  gloryRows: ParticipantRow[];
  weeks: string[];
  coeffs?: EventCoeffs | null;
  squadRows?: SquadRow[];
}

export interface WeightedLeaderboardResult {
  scores: WeightedScoreRow[];
  maxPossible: number;
}

export interface ParticipationLeaderboardParams {
  membersList: string[];
  validRows: ParticipantRow[];
}

export interface EventLeaderboardParams {
  eventName: string;
  rows: ParticipantRow[];
  allSquads: SquadRow[];
  rosterMembers: MemberRow[];
  shadowfrontRate: (eventsDone: number, assignedCount: number) => number;
}

interface ByMemberAcc {
  pseudo: string;
  score: number;
  score_prep: number;
  score_pvp: number;
  events_done: number;
  events_total: number;
  sub_count: number;
  ara_count: number;
  arb_count: number;
  late_count: number;
  excused_count: number;
}

function emptyByMemberAcc(pseudo: string): ByMemberAcc {
  return {
    pseudo,
    score: 0,
    score_prep: 0,
    score_pvp: 0,
    events_done: 0,
    events_total: 0,
    sub_count: 0,
    ara_count: 0,
    arb_count: 0,
    late_count: 0,
    excused_count: 0
  };
}

export function normalizePseudo(p?: string | null): string {
  return p ? String(p).trim().toLowerCase() : '';
}

export function round1(n: number): number {
  return Math.round((n || 0) * 10) / 10;
}

/**
 * Maps a raw DB event_name (e.g. 'Defend Trade Route', 'ARMS RACE STAGE A')
 * to its coefficient bucket key, mirroring stats.js#resolveCoeffBucket.
 */
export function resolveCoeffBucket(evName?: string): EventCoeffBucket | null {
  const row = (evName || '').trim().toLowerCase();
  if (row === 'svs') return 'SvS';
  if (row === 'gvg') return 'GvG';
  if (row.indexOf('shadowfront') !== -1) return 'Shadowfront';
  if (row.indexOf('arms race') !== -1) return 'Arms Race';
  if (row.indexOf('dtr') !== -1 || row.indexOf('defend trade route') !== -1) return 'DTR';
  return null;
}

/**
 * Substring event-family matcher, mirroring stats.js#matchesEventName.
 */
export function matchesEventName(rowEventName?: string, targetMode?: string): boolean {
  const row = (rowEventName || '').trim().toLowerCase();
  const target = (targetMode || '').trim().toLowerCase();
  if (target === 'svs') return row === 'svs';
  if (target === 'gvg') return row === 'gvg';
  if (target === 'shadowfront') return row.indexOf('shadowfront') !== -1;
  if (target === 'arms race') return row.indexOf('arms race') !== -1;
  if (target === 'dtr') return row.indexOf('dtr') !== -1 || row.indexOf('defend trade route') !== -1;
  if (target === 'glory') return row.indexOf('glory') !== -1;
  return row === target;
}
