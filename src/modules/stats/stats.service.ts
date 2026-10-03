/**
 * src/modules/stats/stats.service.ts
 *
 * Pure leaderboard computation for the Stats page: weighted scoring, attendance
 * rates and per-event aggregation. No DOM. The only I/O is the query builders
 * at the end of the file (M4b), which return the query for the view to await.
 */

import { eventScoringKey } from '../../core/config/events';
import type { DbClient } from '../../core/api/db-client';
import { weightedRate, type BucketCounts } from '../../core/scoring/reliability';


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

    // The weighting itself lives in core/scoring/reliability.ts, because the
    // player Portal publishes the same number to a different audience and the
    // two used to disagree -- 48.1% against 31.6% on the same guild.
    const rateOf = (buckets: Record<string, { att?: number; opp?: number }> | undefined) => {
      const w = weightedRate(buckets as Record<string, BucketCounts> | undefined, useCoeffs);
      return { rate: w.rate, att: w.attended, opp: w.opportunities };
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

      const overall = rateOf(bucketMap as Record<string, { att?: number; opp?: number }>);

      const tr = m.trend || null;
      const recent = tr ? rateOf(tr.recent) : { rate: null, att: 0, opp: 0 };
      const prior = tr ? rateOf(tr.prior) : { rate: null, att: 0, opp: 0 };
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
   * The per-event board, from gm_stats_events.
   *
   * Replaces computeEventLeaderboard, which was the third of the five
   * divergent attendance formulas and the worst of them: it counted ROWS and
   * divided by the member's OWN row count, so anyone with exactly one row
   * scored 100%. It also keyed Shadowfront by session where every other part
   * of the page keys it by week, so a member in both squads counted twice here
   * and once everywhere else.
   *
   * The rate is now att/opp against the member's own opportunities -- the same
   * rule as the members board and the Health tab. A member the guild never
   * asked (opp = 0) gets a null rate and renders as an em dash.
   */
  public static computeEventLeaderboardFromPayload(payload: StatsEventsPayload): EventScoreRow[] {
    const rows = (payload.members || []).map((m) => {
      const opp = Number(m.opp) || 0;
      const att = Number(m.att) || 0;
      const sq = m.squad || null;
      return {
        pseudo: m.pseudo,
        score: Number(m.score) || 0,
        score_prep: Number(m.score_prep) || 0,
        score_pvp: Number(m.score_pvp) || 0,
        events_done: att,
        events_total: opp,
        sub_count: Number(m.sub_count) || 0,
        assigned_count: sq ? sq.assigned : 0,
        participant_count: sq ? sq.participant : 0,
        reserve_count: sq ? sq.reserve : 0,
        squad1_count: sq ? sq.squad1 : 0,
        squad2_count: sq ? sq.squad2 : 0,
        commander_count: sq ? sq.commander : 0,
        ara_count: Number(m.stage_a) || 0,
        arb_count: Number(m.stage_b) || 0,
        late_count: Number(m.late_count) || 0,
        excused_count: Number(m.excused_count) || 0,
        attendance_rate: opp > 0 ? att / opp : 0,
        glory_delta: 0,
        glory_bonus: 0,
        consistency_bonus: 0
      } as EventScoreRow;
    });

    return rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.events_done !== a.events_done) return b.events_done - a.events_done;
      if (b.attendance_rate !== a.attendance_rate) return b.attendance_rate - a.attendance_rate;
      return a.pseudo.localeCompare(b.pseudo);
    });
  }

  // computeEventLeaderboard() was removed in phase S5, with the raw-row payload
  // it consumed. It was the third of the five divergent attendance formulas and
  // the least defensible: it counted ROWS and divided by the member's OWN row
  // count, so a member with exactly one row scored 100%. It also keyed
  // Shadowfront by session_id where every other part of the page keys it by
  // week, so a member in both squads of one week counted twice here and once
  // everywhere else. computeEventLeaderboardFromPayload() replaces it.

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

/* ── gm_stats_events ──────────────────────────────────────────────────────── */

export interface EventsSquad {
  assigned: number; participant: number; reserve: number;
  squad1: number; squad2: number; commander: number;
}
export interface EventsMemberRow {
  pseudo: string;
  uid?: string | null;
  role?: string | null;
  overall_power?: number;
  att: number;
  opp: number;
  score: number;
  score_prep: number;
  score_pvp: number;
  late_count: number;
  excused_count: number;
  sub_count: number;
  stage_a: number;
  stage_b: number;
  squad?: EventsSquad | null;
}
export interface EventsWar {
  session_id: string;
  opponent: string | null;
  start_at: string | null;
  results: Record<string, string | null>;
}
export interface StatsEventsPayload {
  ok: boolean;
  error?: string;
  guild?: string;
  bucket?: string;
  weeks?: string[];
  sessions?: Array<{ key: string; week_start: string; present: number }>;
  war?: EventsWar[];
  members?: EventsMemberRow[];
}

/* ── gm_stats_health ──────────────────────────────────────────────────────── */

export interface HealthWeek { week_start: string; opportunities: number; present_members: number; }
export interface HealthWar {
  event_name: string;
  sessions: number;
  day_wins: number;
  day_losses: number;
  per_day: Record<string, { won: number; lost: number }>;
}
export interface HealthPowerPoint { week_start: string; players: number; median: number; avg: number; }
export interface StatsHealthPayload {
  ok: boolean;
  error?: string;
  guild?: string;
  weeks?: number;
  roster_size?: number;
  participation?: HealthWeek[];
  war?: HealthWar[];
  power?: { series: HealthPowerPoint[]; weeks: number };
  coverage?: Record<string, number>;
  quality?: {
    pending_rows: number;
    weeks_with_data: number;
    last_week: string | null;
    /** Rows already entered for weeks that have not started. */
    scheduled_ahead?: number;
  };
}

/* ── Engagement segmentation ──────────────────────────────────────────────── */

export type EngagementSegment = 'core' | 'regular' | 'occasional' | 'dormant' | 'unmeasured';

/**
 * Thresholds calibrated against production, not chosen for roundness.
 *
 * Weighted reliability over 4-week windows, 2,403 members across every guild
 * with data (2026-09-27): p25 = 0.0, median = 21.7, p75 = 48.0, p90 = 66.7.
 * 862 members sit at exactly zero.
 *
 * At 60 and 30 the population splits 18% core / 24% regular / 22% occasional /
 * 36% dormant, which is a segmentation an admin can act on. Rounder-looking
 * cuts do not: at 80 the "core" is 6% of the roster, and at 50 it is a third.
 */
export const ENGAGEMENT_THRESHOLDS = { core: 60, regular: 30 } as const;

export function segmentOf(row: { reliability: number | null }): EngagementSegment {
  if (row.reliability === null || row.reliability === undefined) return 'unmeasured';
  if (row.reliability >= ENGAGEMENT_THRESHOLDS.core) return 'core';
  if (row.reliability >= ENGAGEMENT_THRESHOLDS.regular) return 'regular';
  if (row.reliability > 0) return 'occasional';
  return 'dormant';
}

export function summariseEngagement(rows: Array<{ reliability: number | null }>):
  Record<EngagementSegment, number> {
  const out: Record<EngagementSegment, number> =
    { core: 0, regular: 0, occasional: 0, dormant: 0, unmeasured: 0 };
  rows.forEach((r) => { out[segmentOf(r)] += 1; });
  return out;
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

// ---------------------------------------------------------------------------
// Queries (M4b). Each returns the builder/promise; the view awaits it.
// ---------------------------------------------------------------------------

/** The weeks that hold participation data for a guild (gm_stats_weeks). */
export function queryStatsWeeks(db: DbClient, guild: string | null) {
  return db.rpc('gm_stats_weeks', { p_guild: guild });
}

/** Guild health over the last eight weeks (gm_stats_health). */
export function queryStatsHealth(db: DbClient, guild: string | null) {
  return db.rpc('gm_stats_health', { p_guild: guild, p_weeks: 8 });
}

/** Per-member aggregates over the given weeks, all weeks when empty (gm_stats_members). */
export function queryStatsMembers(db: DbClient, guild: string | null, weeks: string[], withTrend?: boolean) {
  return db.rpc('gm_stats_members', {
    p_guild: guild,
    p_weeks: weeks && weeks.length ? weeks : null,
    p_trend: withTrend === true
  });
}

/** The guild's roster with power and role. */
export function queryRosterPower(db: DbClient, guild: string | null) {
  return db.from('guild_members').select('pseudo, overall_power, role').eq('guild', guild);
}

/** Pending transfers into the guild. */
export function queryPendingIncomingTransfers(db: DbClient, guild: string | null) {
  return db.from('guild_transfers').select('pseudo, source_guild, status').eq('status', 'pending').eq('target_guild', guild);
}

/** Per-event aggregates for one scoring bucket over the given weeks (gm_stats_events). */
export function queryStatsEvents(db: DbClient, guild: string | null, bucket: unknown, requested: string[]) {
  return db.rpc('gm_stats_events', {
    p_guild: guild,
    p_bucket: bucket,
    p_weeks: requested && requested.length ? requested : null
  });
}
