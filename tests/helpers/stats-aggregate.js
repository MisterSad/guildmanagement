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
  const perKey = new Map();
  for (const r of valid) {
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
    prev.attended = prev.attended || attended;
    prev.present = prev.present || present;
    prev.scored = prev.scored || scored;
    perKey.set(id, prev);
  }
  const keys = [...perKey.values()];

  const bucketOpp = {};
  for (const bucket of new Set(keys.map((k) => k.bucket))) {
    bucketOpp[bucket] = new Set(keys.filter((k) => k.bucket === bucket).map((k) => k.skey)).size;
  }
  const totalEvents = Object.values(bucketOpp).reduce((a, b) => a + b, 0);

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
      uid: m.uid || null,
      role: m.role || null,
      overall_power: m.overall_power || 0,
      attended: mine.filter((k) => k.attended).length,
      present: mine.filter((k) => k.present).length,
      weeks_active: new Set(mine.filter((k) => k.attended).map((k) => k.week)).size,
      last_seen_week: mine.filter((k) => k.attended).map((k) => k.week).sort().pop() || null,
      ...flagsFor(pseudo),
      buckets
    };
  }).sort((a, b) => String(a.pseudo).localeCompare(String(b.pseudo)));

  return {
    ok: true,
    guild: null,
    weeks: weeks && weeks.length ? weeks.slice() : [...new Set(valid.map((r) => r.week_start))].sort().reverse(),
    tenant: { total_events: totalEvents, buckets: bucketOpp },
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
