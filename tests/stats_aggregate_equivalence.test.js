/**
 * Phase S2: the SQL aggregate must produce the same leaderboard as the row walk.
 *
 * `gm_stats_members` moves the counting into Postgres. The risk of that move is
 * not that it fails loudly -- it is that every member's score shifts by a
 * little and nobody notices until a guild leader asks why their roster
 * re-ordered. So the two implementations are fed the same fixture here and
 * their output is compared row for row, field for field.
 *
 * The fixture is built once, as raw rows, and the aggregate is derived from it
 * by `aggregateLikeSql()` below -- a deliberately literal transcription of the
 * SQL CTEs. If the SQL and this transcription drift, the migration's own
 * DO $verify$ block catches the bucket half against production data, and the
 * payload-shape test at the bottom catches the rest.
 */

import { describe, it, expect } from 'vitest';
import { StatsService } from '../src/modules/stats/stats.service';
import { eventScoringKey } from '../src/core/config/events';
import { DEFAULT_EVENT_COEFFS } from '../src/core/config/event-coeffs';

const W1 = '2026-09-07';
const W2 = '2026-09-14';
const WEEKS = [W2, W1];

const MEMBERS = ['AlphaPrime', 'BetaKnight', 'GammaGhost', 'DeltaRunner'];

/**
 * Deliberately awkward fixture: two weeks, five buckets, an uppercase event
 * name that earns the coefficient but not the performance bonus (DEMO's seed
 * casing), a member with no rows at all, a substitute, an excused row, and a
 * row whose only evidence of attendance is a score.
 */
const ROWS = [
  // SvS: both weeks, scored -> participation + performance, coefficient 5.
  { pseudo: 'AlphaPrime', event_name: 'SvS', week_start: W1, session_id: 'SVS-1', participated: 1, score_prep: 1200, score_pvp: 800 },
  { pseudo: 'AlphaPrime', event_name: 'SvS', week_start: W2, session_id: 'SVS-2', participated: 1, score_prep: 1500, score_pvp: 0 },
  { pseudo: 'BetaKnight', event_name: 'SvS', week_start: W1, session_id: 'SVS-1', participated: 1, score_prep: 0, score_pvp: 0 },
  { pseudo: 'BetaKnight', event_name: 'SvS', week_start: W2, session_id: 'SVS-2', participated: 0 },

  // GvG: attendance evidenced only by a score, which the weighted board counts
  // as attended and the attendance-rate board does not.
  { pseudo: 'AlphaPrime', event_name: 'GvG', week_start: W1, session_id: 'GVG-1', participated: 0, score: 5000 },
  { pseudo: 'GammaGhost', event_name: 'GvG', week_start: W1, session_id: 'GVG-1', participated: 1 },

  // Uppercase SVS in the same week as SvS: same bucket and coefficient, but the
  // performance bonus keys on the literal name, so it must NOT earn one.
  { pseudo: 'GammaGhost', event_name: 'SVS', week_start: W2, session_id: 'SVS-2', participated: 1, score_prep: 9999 },

  // Shadowfront: keyed by week only, so two squads in one week are one
  // opportunity. The substitute counts on both boards.
  { pseudo: 'AlphaPrime', event_name: 'Shadowfront', week_start: W1, session_id: 'SF-A', participated: 1 },
  { pseudo: 'AlphaPrime', event_name: 'Shadowfront', week_start: W1, session_id: 'SF-B', participated: 1 },
  { pseudo: 'BetaKnight', event_name: 'Shadowfront', week_start: W1, session_id: 'SF-A', participated: 0, sub_present: true },
  { pseudo: 'GammaGhost', event_name: 'Shadowfront', week_start: W2, session_id: 'SF-C', participated: 0, excused: true },

  // DTR keeps its session, so three sessions in one week are three chances.
  { pseudo: 'AlphaPrime', event_name: 'Defend Trade Route', week_start: W1, session_id: 'DTR-1', participated: 1 },
  { pseudo: 'AlphaPrime', event_name: 'Defend Trade Route', week_start: W1, session_id: 'DTR-2', participated: 1 },
  { pseudo: 'BetaKnight', event_name: 'Defend Trade Route', week_start: W1, session_id: 'DTR-1', participated: 1, late: true },
  { pseudo: 'DeltaRunner', event_name: 'Defend Trade Route', week_start: W2, session_id: 'DTR-3', participated: 1 },

  // Arms Race, two stages, coefficient 1: the bucket that dominates the flat
  // denominator and is the whole reason phase S3 exists.
  { pseudo: 'AlphaPrime', event_name: 'ARMS RACE STAGE A', week_start: W1, session_id: 'ARA-1', participated: 1 },
  { pseudo: 'AlphaPrime', event_name: 'ARMS RACE STAGE B', week_start: W1, session_id: 'ARB-1', participated: 1 },
  { pseudo: 'BetaKnight', event_name: 'ARMS RACE STAGE A', week_start: W1, session_id: 'ARA-1', participated: 0 },
  { pseudo: 'DeltaRunner', event_name: 'Arms Race Stage A', week_start: W2, session_id: 'ARA-2', participated: 1 }
  // GammaGhost has Shadowfront/GvG/SVS only; DeltaRunner has no SvS at all.
];

const GLORY = [
  { pseudo: 'AlphaPrime', week_start: W1, score: 1000 },
  { pseudo: 'AlphaPrime', week_start: W2, score: 4000 },
  { pseudo: 'BetaKnight', week_start: W1, score: 5000 },
  { pseudo: 'BetaKnight', week_start: W2, score: 5200 },
  { pseudo: 'GammaGhost', week_start: W2, score: 700 }
];

const norm = (p) => String(p || '').trim().toLowerCase();

/** A literal transcription of the CTE chain in gm_stats_members. */
function aggregateLikeSql(rows, gloryRows, members, weeks) {
  const inWindow = rows.filter((r) => weeks.indexOf(r.week_start) !== -1);

  // keyed -> per_key: collapse to one entry per (member, scoring key).
  const perKey = new Map();
  for (const r of inWindow) {
    const skey = eventScoringKey(r.event_name, r.session_id, r.week_start);
    const id = norm(r.pseudo) + '\u0000' + skey;
    const attended = Number(r.participated) > 0 || r.sub_present === true ||
      Number(r.score) > 0 || Number(r.score_prep) > 0 || Number(r.score_pvp) > 0;
    const present = Number(r.participated) > 0 || r.sub_present === true;
    const scored = (r.event_name === 'SvS' || r.event_name === 'GvG') &&
      ((Number(r.score) || 0) + (Number(r.score_prep) || 0) + (Number(r.score_pvp) || 0)) > 0;
    const prev = perKey.get(id) || {
      pseudo: r.pseudo, skey, bucket: skey.split('|')[0], week: r.week_start,
      attended: false, present: false, scored: false
    };
    prev.attended = prev.attended || attended;   // bool_or
    prev.present = prev.present || present;
    prev.scored = prev.scored || scored;
    perKey.set(id, prev);
  }
  const keys = [...perKey.values()];

  // tenant_buckets
  const bucketOpp = {};
  for (const bucket of new Set(keys.map((k) => k.bucket))) {
    bucketOpp[bucket] = new Set(keys.filter((k) => k.bucket === bucket).map((k) => k.skey)).size;
  }
  const totalEvents = Object.values(bucketOpp).reduce((a, b) => a + b, 0);

  // per_member_bucket + per_member
  const out = members.map((pseudo) => {
    const mine = keys.filter((k) => norm(k.pseudo) === norm(pseudo));
    const buckets = {};
    for (const bucket of new Set(mine.map((k) => k.bucket))) {
      const slice = mine.filter((k) => k.bucket === bucket);
      buckets[bucket] = {
        att: slice.filter((k) => k.attended).length,
        att_scored: slice.filter((k) => k.attended && k.scored).length,
        present: slice.filter((k) => k.present).length
      };
    }
    return {
      pseudo,
      attended: mine.filter((k) => k.attended).length,
      present: mine.filter((k) => k.present).length,
      weeks_active: new Set(mine.filter((k) => k.attended).map((k) => k.week)).size,
      last_seen_week: mine.filter((k) => k.attended).map((k) => k.week).sort().pop() || null,
      late_count: 0, excused_count: 0, sub_count: 0,
      buckets
    };
  });

  return {
    ok: true,
    tenant: { total_events: totalEvents, buckets: bucketOpp },
    members: out,
    glory: gloryRows.map((g) => [g.pseudo, g.week_start, g.score])
  };
}

describe('the SQL aggregate produces the same weighted leaderboard as the row walk', () => {
  const payload = aggregateLikeSql(ROWS, GLORY, MEMBERS, WEEKS);

  const fromRows = StatsService.computeWeightedLeaderboard({
    membersList: MEMBERS, partRows: ROWS, gloryRows: GLORY, weeks: WEEKS, coeffs: DEFAULT_EVENT_COEFFS
  });
  const fromAggregate = StatsService.computeWeightedLeaderboardFromAggregate(
    payload, WEEKS, DEFAULT_EVENT_COEFFS
  );

  it('ranks the same members in the same order', () => {
    expect(fromAggregate.scores.map((r) => r.pseudo)).toEqual(fromRows.scores.map((r) => r.pseudo));
  });

  it('matches every field of every row', () => {
    const strip = (rows) => rows.map((r) => ({
      pseudo: r.pseudo,
      score: r.score,
      events_score: r.events_score,
      events_done: r.events_done,
      events_total: r.events_total,
      attendance_rate: Math.round(r.attendance_rate * 1e6) / 1e6,
      glory_delta: r.glory_delta,
      glory_bonus: r.glory_bonus,
      consistency_bonus: r.consistency_bonus
    }));
    expect(strip(fromAggregate.scores)).toEqual(strip(fromRows.scores));
  });

  it('is actually discriminating, not comparing two empty lists', () => {
    // Without this, both implementations returning nothing would "match".
    expect(fromRows.scores.length).toBe(MEMBERS.length);
    expect(fromRows.scores[0].score).toBeGreaterThan(0);
    expect(new Set(fromRows.scores.map((r) => r.score)).size).toBeGreaterThan(1);
  });

  it('gives the uppercase SVS row its coefficient but not the performance bonus', () => {
    // DEMO's seed writes 'SVS'; production writes 'SvS'. The bucket, and so the
    // coefficient, is case-insensitive; the bonus keys on the literal name.
    // Preserved from the row walk rather than quietly "fixed" here -- S3
    // revisits it deliberately.
    const gamma = payload.members.find((m) => m.pseudo === 'GammaGhost');
    expect(gamma.buckets.SvS.att).toBe(1);
    expect(gamma.buckets.SvS.att_scored).toBe(0);
  });

  it('counts two Shadowfront squads in one week as one opportunity', () => {
    expect(payload.tenant.buckets.Shadowfront).toBe(2); // one per week, not per squad
    const alpha = payload.members.find((m) => m.pseudo === 'AlphaPrime');
    expect(alpha.buckets.Shadowfront.att).toBe(1);
  });
});

describe('the SQL aggregate produces the same attendance-rate leaderboard', () => {
  const payload = aggregateLikeSql(ROWS, GLORY, MEMBERS, WEEKS);

  const validRows = ROWS.filter((r) => WEEKS.indexOf(r.week_start) !== -1);
  const fromRows = StatsService.computeParticipationLeaderboard({ membersList: MEMBERS, validRows });
  const fromAggregate = StatsService.computeParticipationLeaderboardFromAggregate(payload);

  it('matches row for row', () => {
    const strip = (rows) => rows.map((r) => ({
      pseudo: r.pseudo, score: r.score, events_done: r.events_done, events_total: r.events_total
    })).sort((a, b) => a.pseudo.localeCompare(b.pseudo));
    expect(strip(fromAggregate)).toEqual(strip(fromRows));
  });

  it('does not count a score-only row as present, where the weighted board does', () => {
    // AlphaPrime's GvG row has participated: 0 and a score. This is the one
    // place the two boards were always meant to disagree, and it survives.
    const weighted = StatsService.computeWeightedLeaderboardFromAggregate(payload, WEEKS, DEFAULT_EVENT_COEFFS);
    const alphaWeighted = weighted.scores.find((r) => r.pseudo === 'AlphaPrime');
    const alphaPresent = fromAggregate.find((r) => r.pseudo === 'AlphaPrime');
    expect(alphaWeighted.events_done).toBeGreaterThan(alphaPresent.events_done);
  });
});
