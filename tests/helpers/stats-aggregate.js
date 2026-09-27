/**
 * A literal transcription of the CTE chain in `gm_stats_members`, for tests.
 *
 * Phase S2 moved the Stats leaderboard aggregation into SQL. The unit tests
 * still want to express their fixtures as raw participation rows, because that
 * is what is readable and what the assertions are about -- so the mock for
 * `gm_stats_members` runs those rows through this, rather than every test
 * hand-writing a payload.
 *
 * Two things keep this honest rather than circular:
 *   - `tests/stats_aggregate_equivalence.test.js` feeds one fixture through
 *     BOTH this aggregate and the original row-walking service, and asserts the
 *     leaderboards match field for field.
 *   - the migration's own DO $verify$ block asserts the SQL bucket expression
 *     equals `gm_event_scoring_key` for every distinct event triple in
 *     production, so the half most likely to drift is checked against real data.
 */

import { eventScoringKey } from '../../src/core/config/events.ts';

const norm = (p) => String(p || '').trim().toLowerCase();

/**
 * @param {object} opts
 * @param {Array} opts.rows        raw event_participants rows (non-Glory)
 * @param {Array} opts.glory       raw Glory rows ({pseudo, week_start, score})
 * @param {Array} opts.members     roster rows ({pseudo, uid, role, overall_power})
 * @param {Array<string>} [opts.weeks] week window; omit for every week present
 */
export function aggregateStatsMembers({ rows = [], glory = [], members = [], weeks = null }) {
  const nonGlory = rows.filter((r) => String(r.event_name || '').toLowerCase() !== 'glory');
  const windowed = weeks && weeks.length
    ? nonGlory.filter((r) => weeks.indexOf(r.week_start) !== -1)
    : nonGlory;

  // The SQL drops pending rows before anything else.
  const valid = windowed.filter((r) => !r.is_pending);

  // keyed -> per_key: one entry per (member, scoring key), folded with bool_or.
  // ONE attendance rule since phase S3: participated > 0 OR sub_present.
  const perKey = new Map();
  for (const r of valid) {
    const skey = eventScoringKey(r.event_name, r.session_id, r.week_start);
    const id = norm(r.pseudo) + '\u0000' + skey;
    const present = Number(r.participated) > 0 || r.sub_present === true;
    const scored = (r.event_name === 'SvS' || r.event_name === 'GvG') &&
      ((Number(r.score) || 0) + (Number(r.score_prep) || 0) + (Number(r.score_pvp) || 0)) > 0;
    const prev = perKey.get(id) || {
      pseudo: r.pseudo, skey, bucket: skey.split('|')[0], week: r.week_start,
      present: false, scored: false, excused: false
    };
    prev.present = prev.present || present;
    prev.scored = prev.scored || scored;
    prev.excused = prev.excused || r.excused === true;
    perKey.set(id, prev);
  }
  const keys = [...perKey.values()];

  // Every opportunity the guild ran, once each.
  const opportunities = [];
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k.skey)) continue;
    seen.add(k.skey);
    opportunities.push({ skey: k.skey, bucket: k.bucket, week: k.week });
  }

  const bucketOpp = {};
  for (const o of opportunities) bucketOpp[o.bucket] = (bucketOpp[o.bucket] || 0) + 1;
  const totalEvents = opportunities.length;

  const joinedWeek = (m) => {
    if (!m.created_at) return '0000-01-01';
    const d = new Date(m.created_at);
    const day = (d.getUTCDay() + 6) % 7;            // Monday = 0
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  };

  // Flags come from the row level, not the key level, matching the SQL.
  const flagsFor = (pseudo) => {
    const mine = valid.filter((r) => norm(r.pseudo) === norm(pseudo));
    return {
      late_count: mine.filter((r) => r.late === true).length,
      excused_count: mine.filter((r) => r.excused === true).length,
      sub_count: mine.filter((r) => r.sub_present === true).length
    };
  };

  const memberRows = members.map((m) => {
    const pseudo = m.pseudo;
    const since = joinedWeek(m);
    const mine = keys.filter((k) => norm(k.pseudo) === norm(pseudo));
    const excusedKeys = new Set(mine.filter((k) => k.excused).map((k) => k.skey));

    // The denominator, per member: opportunities from their roster week
    // onward, minus the ones they were excused from.
    const buckets = {};
    for (const o of opportunities) {
      if (o.week < since) continue;
      if (excusedKeys.has(o.skey)) continue;
      buckets[o.bucket] = buckets[o.bucket] || { att: 0, opp: 0, exc: 0, att_scored: 0 };
      buckets[o.bucket].opp += 1;
    }
    for (const bucket of new Set(mine.map((k) => k.bucket))) {
      const slice = mine.filter((k) => k.bucket === bucket);
      buckets[bucket] = buckets[bucket] || { att: 0, opp: 0, exc: 0, att_scored: 0 };
      buckets[bucket].att = slice.filter((k) => k.present).length;
      buckets[bucket].att_scored = slice.filter((k) => k.present && k.scored).length;
      buckets[bucket].exc = slice.filter((k) => k.excused).length;
    }

    return {
      pseudo,
      uid: m.uid || null,
      role: m.role || null,
      overall_power: m.overall_power || 0,
      joined_week: since,
      attended: mine.filter((k) => k.present).length,
      weeks_active: new Set(mine.filter((k) => k.present).map((k) => k.week)).size,
      last_seen_week: mine.filter((k) => k.present).map((k) => k.week).sort().pop() || null,
      ...flagsFor(pseudo),
      buckets,
      trend: null
    };
  }).sort((a, b) => String(a.pseudo).localeCompare(String(b.pseudo)));

  return {
    ok: true,
    guild: null,
    weeks: weeks && weeks.length ? weeks.slice() : [...new Set(valid.map((r) => r.week_start))].sort().reverse(),
    tenant: { total_events: totalEvents, buckets: bucketOpp },
    trend: null,
    members: memberRows,
    glory: glory
      .filter((g) => Number(g.score) > 0)
      .filter((g) => !weeks || !weeks.length || weeks.indexOf(g.week_start) !== -1)
      .map((g) => [g.pseudo, g.week_start, Number(g.score) || 0])
  };
}

/** Drop-in `rpc.gm_stats_members` handler for the test db mocks. */
export function mockStatsMembers({ rows = [], glory = [], members = [] }) {
  return (params) => ({
    data: aggregateStatsMembers({
      rows, glory, members,
      weeks: params && params.p_weeks ? params.p_weeks : null
    }),
    error: null
  });
}

/**
 * Drop-in `rpc.gm_stats_health` handler: the guild-level shape the Health tab
 * consumes, derived from the same raw fixtures as mockStatsMembers so a test
 * does not have to keep two descriptions of one guild in sync.
 */
export function mockStatsHealth({ rows = [], members = [], war = [], power = [], currentWeek = null }) {
  const nonGlory = rows
    .filter((r) => String(r.event_name || '').toLowerCase() !== 'glory' && !r.is_pending)
    // A week that has not started cannot have results. The RPC applies this in
    // SQL with date_trunc('week', now()); the mock is told the current week.
    .filter((r) => !currentWeek || r.week_start <= currentWeek);
  const weeks = [...new Set(nonGlory.map((r) => r.week_start))].sort();

  const participation = weeks.map((w) => {
    const inWeek = nonGlory.filter((r) => r.week_start === w);
    return {
      week_start: w,
      opportunities: new Set(inWeek.map((r) => eventScoringKey(r.event_name, r.session_id, r.week_start))).size,
      present_members: new Set(
        inWeek.filter((r) => Number(r.participated) > 0 || r.sub_present === true).map((r) => r.pseudo)
      ).size
    };
  });

  const nonZero = (field) => members.filter((m) => Number(m[field] || 0) > 0).length;

  return () => ({
    data: {
      ok: true,
      guild: null,
      weeks: weeks.length,
      roster_size: members.length,
      participation,
      war,
      power: { series: power, weeks: power.length },
      coverage: {
        members: members.length,
        overall_power: nonZero('overall_power'),
        tech_power: nonZero('tech_power'),
        champion_power: nonZero('champion_power'),
        crew_power: nonZero('crew_power'),
        flagship_power: nonZero('flagship_power'),
        fleet_rating: nonZero('fleet_rating'),
        glory_score: nonZero('glory_score')
      },
      quality: {
        pending_rows: rows.filter((r) => r.is_pending).length,
        weeks_with_data: weeks.length,
        last_week: weeks.length ? weeks[weeks.length - 1] : null
      }
    },
    error: null
  });
}
