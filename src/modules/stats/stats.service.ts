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

  /**
   * Reliability: one rate per event bucket, then one weighted number.
   *
   *     reliability = 100 * SUM_b coeff(b) * att(m,b) / SUM_b coeff(b) * opp(m,b)
   *
   * Replaces both the old "Global Score (Composite)" and "Attendance Rate (%)"
   * boards, which were two answers to one question and disagreed about the
   * same member.
   *
   * Why weighting is the whole point, measured on ALPHA for the week of
   * 2026-08-31: the guild ran 7 Arms Race sessions, 3 DTR, 1 Shadowfront,
   * 1 SvS and 1 GvG. Counting instances equally gave Arms Race -- daily, and
   * skipped by design, 16.2% participation across production -- 54% of the
   * score, and the SvS 7.7%. With the tenant's coefficients the same week
   * gives Arms Race 27% and the SvS 19%.
   *
   * `opp` arrives per member, already limited to the weeks since they joined
   * the roster and already excluding what they were excused from, so this is a
   * weighted sum and nothing more. A bucket with opp = 0 contributes to neither
   * side and renders as an em dash: a guild that ran no Shadowfront must not
   * make its members look absent from one.
   */
  public static computeReliabilityLeaderboard(
    payload: StatsMembersPayload,
    coeffs?: EventCoeffs
  ): ReliabilityRow[] {
    const useCoeffs: EventCoeffs = coeffs || DEFAULT_EVENT_COEFFS;
    const coeffOf = (bucket: string): number => {
      const key = resolveCoeffBucket(bucket);
      return (key && useCoeffs[key] != null) ? useCoeffs[key] : 1;
    };

    const weightedRate = (buckets: Record<string, { att?: number; opp?: number }> | undefined):
      { rate: number | null; att: number; opp: number } => {
      let att = 0;
      let opp = 0;
      Object.keys(buckets || {}).forEach((bucket) => {
        const b = (buckets as Record<string, { att?: number; opp?: number }>)[bucket] || {};
        const c = coeffOf(bucket);
        att += c * (Number(b.att) || 0);
        opp += c * (Number(b.opp) || 0);
      });
      return { rate: opp > 0 ? (att / opp) * 100 : null, att, opp };
    };

    const rows: ReliabilityRow[] = (payload.members || []).map((m) => {
      const bucketMap = (m.buckets || {}) as Record<string, AggregateBucketCounts>;
      const buckets: ReliabilityBucket[] = Object.keys(bucketMap).map((bucket) => {
        const b = bucketMap[bucket] || ({} as AggregateBucketCounts);
        const opp = Number(b.opp) || 0;
        const att = Number(b.att) || 0;
        return {
          bucket,
          att,
          opp,
          exc: Number(b.exc) || 0,
          coeff: coeffOf(bucket),
          rate: opp > 0 ? round1((att / opp) * 100) : null
        };
      }).sort((a, b) => (b.coeff - a.coeff) || a.bucket.localeCompare(b.bucket));

      const overall = weightedRate(bucketMap as Record<string, { att?: number; opp?: number }>);

      const tr = m.trend || null;
      const recent = tr ? weightedRate(tr.recent) : { rate: null, att: 0, opp: 0 };
      const prior = tr ? weightedRate(tr.prior) : { rate: null, att: 0, opp: 0 };
      // A trend needs something on both sides. Without this guard a member who
      // simply was not there four weeks ago reads as a collapse.
      const eligible = !!tr && recent.rate !== null && prior.rate !== null
        && recent.opp >= MIN_TREND_OPPORTUNITIES && prior.opp >= MIN_TREND_OPPORTUNITIES;

      const unweightedOpp = buckets.reduce((acc, b) => acc + b.opp, 0);

      return {
        pseudo: m.pseudo,
        uid: m.uid,
        role: m.role,
        overall_power: Number(m.overall_power) || 0,
        reliability: overall.rate === null ? null : round1(overall.rate),
        weighted_att: overall.att,
        weighted_opp: overall.opp,
        buckets,
        trend: {
          recent: recent.rate === null ? null : round1(recent.rate),
          prior: prior.rate === null ? null : round1(prior.rate),
          delta: eligible ? round1((recent.rate as number) - (prior.rate as number)) : null,
          eligible
        },
        weeks_active: Number(m.weeks_active) || 0,
        last_seen_week: m.last_seen_week,
        score: overall.rate === null ? 0 : round1(overall.rate),
        events_done: Number(m.attended) || 0,
        events_total: unweightedOpp,
        attendance_rate: overall.rate === null ? 0 : overall.rate / 100,
        glory_delta: 0,
        glory_bonus: 0,
        consistency_bonus: 0
      };
    });

    return rows.sort((a, b) => {
      // Members with no opportunities at all sort last: they are not bad, they
      // are unmeasured, and mixing them in with 0% would say the wrong thing.
      const ar = a.reliability;
      const br = b.reliability;
      if (ar === null && br === null) return a.pseudo.localeCompare(b.pseudo);
      if (ar === null) return 1;
      if (br === null) return -1;
      if (br !== ar) return br - ar;
      if (b.weighted_opp !== a.weighted_opp) return b.weighted_opp - a.weighted_opp;
      return a.pseudo.localeCompare(b.pseudo);
    });
  }



  // computeWeightedLeaderboard(), computeWeightedLeaderboardFromAggregate(),
  // computeParticipationLeaderboard() and computeParticipationLeaderboardFromAggregate()
  // were removed in phase S3, replaced by computeReliabilityLeaderboard above.
  //
  // The first two implemented the composite points score: 6*coeff per attended
  // instance, +4*coeff for a scored SvS/GvG, a +15*weeks cliff at exactly 80%
  // attendance, and a glory bonus normalised against the best delta in the
  // guild. It was unbounded, so it could not be compared across guilds or
  // windows, and it was measured against "everything the guild ran", which let
  // the daily Arms Race decide over half of it.
  //
  // The other two were the second answer to the same question -- the page
  // offered both in a dropdown, and they disagreed about the same member,
  // because one counted a recorded score as attendance and the other did not.
  // That clause turned out to be decorative: across all 49,701 non-Glory rows
  // in production, ZERO carry a score without also being marked present.
  //
  // The equivalence test that pinned the S2 port went with them; its subject
  // no longer exists. What replaced it is tests/stats_reliability.test.js.


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

/**
 * A trend is only shown when both windows carry at least this much weighted
 * opportunity. Below it the comparison is noise: one missed SvS in a quiet
 * fortnight would read as a 30-point collapse.
 */
export const MIN_TREND_OPPORTUNITIES = 8;

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

/* ── The aggregated payload from gm_stats_members ──────────────────────────
 *
 * Phase S2. The RPC returns counters, never a score: the per-tenant
 * coefficients live in `guild_config` and are declared once, in
 * src/core/config/event-coeffs.ts. Declaring them in SQL too would recreate
 * finding B1 across a language boundary where tsc cannot see the drift.
 */

export interface AggregateBucketCounts {
  /** Distinct scoring keys in this bucket the member attended. */
  att: number;
  /**
   * Opportunities THIS member had in this bucket: everything the guild ran in
   * the window from the member's roster week onward, minus the sessions they
   * were excused from. Per member, not per tenant -- that is the whole point
   * of phase S3.
   */
  opp: number;
  /** Sessions in this bucket the member was excused from. */
  exc: number;
  /** Of the attended ones, how many carried a score. Only ever non-zero for the literal names 'SvS'/'GvG'. */
  att_scored: number;
}

export interface AggregateTrendWindow {
  [bucket: string]: { att: number; opp: number };
}

export interface AggregateMemberRow {
  pseudo: string;
  uid?: string | null;
  role?: string | null;
  overall_power?: number;
  attended: number;
  weeks_active: number;
  last_seen_week?: string | null;
  late_count: number;
  excused_count: number;
  sub_count: number;
  buckets: Record<string, AggregateBucketCounts>;
  /** Present only when the RPC was called with p_trend. */
  trend?: { recent: AggregateTrendWindow; prior: AggregateTrendWindow } | null;
}

export interface StatsMembersPayload {
  ok: boolean;
  error?: string;
  guild?: string;
  weeks?: string[];
  tenant?: { total_events: number; buckets: Record<string, number> };
  members?: AggregateMemberRow[];
  /** Present only when the RPC was called with p_trend. */
  trend?: { weeks_recent: number; weeks_prior: number } | null;
  /** [pseudo, week_start, score] triples, one per member-week with a score. */
  glory?: Array<[string, string, number]>;
}

export interface ReliabilityBucket {
  bucket: string;
  att: number;
  /** Opportunities THIS member had: from their roster week, minus their excused. */
  opp: number;
  exc: number;
  coeff: number;
  /** null when opp is 0 -- "was never asked", which must not render as 0%. */
  rate: number | null;
}

export interface ReliabilityTrend {
  recent: number | null;
  prior: number | null;
  delta: number | null;
  /** False when there is not enough history on either side to compare. */
  eligible: boolean;
}

export interface ReliabilityRow {
  pseudo: string;
  uid?: string | null;
  role?: string | null;
  overall_power: number;
  /** 0-100, or null when the member had no opportunities at all. */
  reliability: number | null;
  weighted_att: number;
  weighted_opp: number;
  buckets: ReliabilityBucket[];
  trend: ReliabilityTrend;
  weeks_active: number;
  last_seen_week?: string | null;
  /* Fields the existing table renderer reads. */
  score: number;
  events_done: number;
  events_total: number;
  attendance_rate: number;
  glory_delta: number;
  glory_bonus: number;
  consistency_bonus: number;
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
