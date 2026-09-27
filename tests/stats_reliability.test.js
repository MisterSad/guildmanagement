/**
 * Phase S3: the reliability model.
 *
 *     reliability = 100 * SUM_b coeff(b) * att(m,b) / SUM_b coeff(b) * opp(m,b)
 *
 * This replaces a composite points score that was measured against "everything
 * the guild ran". Measured on ALPHA for the week of 2026-08-31: 7 Arms Race
 * sessions, 3 DTR, 1 Shadowfront, 1 SvS, 1 GvG. Counting instances equally gave
 * the daily, structurally-skipped Arms Race 54% of the score and the SvS 7.7%.
 *
 * The properties asserted here are the ones an admin would complain about if
 * they broke, in the order they would notice.
 */

import { describe, it, expect } from 'vitest';
import { StatsService, MIN_TREND_OPPORTUNITIES } from '../src/modules/stats/stats.service';
import { DEFAULT_EVENT_COEFFS } from '../src/core/config/event-coeffs';

/** Minimal gm_stats_members payload. */
function payload(members, trendMeta) {
  return {
    ok: true,
    guild: 'ALPHA',
    weeks: ['2026-09-14', '2026-09-07'],
    tenant: { total_events: 0, buckets: {} },
    trend: trendMeta || null,
    members,
    glory: []
  };
}

const member = (pseudo, buckets, extra) => ({
  pseudo,
  uid: null,
  role: 'R1',
  overall_power: 0,
  attended: Object.values(buckets).reduce((a, b) => a + (b.att || 0), 0),
  weeks_active: 1,
  last_seen_week: '2026-09-14',
  late_count: 0,
  excused_count: 0,
  sub_count: 0,
  buckets,
  ...(extra || {})
});

const byPseudo = (rows) => Object.fromEntries(rows.map((r) => [r.pseudo, r]));

describe('the weighting is what makes the number defensible', () => {
  it('rewards the events the guild actually organises around', () => {
    // Both members attend 1 of 2 opportunities. One made the SvS (coefficient
    // 5) and skipped an Arms Race day (coefficient 1); the other did the
    // reverse. Under the old flat denominator they were identical at 50%.
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('MadeTheWar', { SvS: { att: 1, opp: 1, exc: 0 }, 'Arms Race': { att: 0, opp: 1, exc: 0 } }),
      member('MadeTheDaily', { SvS: { att: 0, opp: 1, exc: 0 }, 'Arms Race': { att: 1, opp: 1, exc: 0 } })
    ]), DEFAULT_EVENT_COEFFS);

    const m = byPseudo(rows);
    expect(m.MadeTheWar.reliability).toBeCloseTo(83.3, 1);   // 5 / (5+1)
    expect(m.MadeTheDaily.reliability).toBeCloseTo(16.7, 1); // 1 / (5+1)
    expect(rows[0].pseudo).toBe('MadeTheWar');
  });

  it('cancels the coefficient when a member has only one kind of event', () => {
    // Not a bug: a coefficient expresses a trade-off BETWEEN event types. With
    // one bucket it appears on both sides of the fraction.
    const only = (coeffs) => StatsService.computeReliabilityLeaderboard(
      payload([member('Solo', { DTR: { att: 1, opp: 2, exc: 0 } })]), coeffs
    )[0].reliability;

    expect(only(DEFAULT_EVENT_COEFFS)).toBe(50);
    expect(only({ ...DEFAULT_EVENT_COEFFS, DTR: 50 })).toBe(50);
  });

  it('uses the tenant coefficients, not the defaults, when they differ', () => {
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('A', { SvS: { att: 0, opp: 1, exc: 0 }, DTR: { att: 1, opp: 1, exc: 0 } })
    ]), { ...DEFAULT_EVENT_COEFFS, DTR: 50 });
    expect(rows[0].reliability).toBeCloseTo(90.9, 1); // 50 / (50+5)
  });
});

describe('"did not attend" and "was never asked" are different facts', () => {
  it('reports null, not 0%, for a bucket the guild did not run for that member', () => {
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('Only SvS ran', { SvS: { att: 1, opp: 1, exc: 0 }, Shadowfront: { att: 0, opp: 0, exc: 0 } })
    ]), DEFAULT_EVENT_COEFFS);

    const sf = rows[0].buckets.find((b) => b.bucket === 'Shadowfront');
    expect(sf.opp).toBe(0);
    expect(sf.rate).toBeNull();          // renders as an em dash
    expect(rows[0].reliability).toBe(100); // and contributes to neither side
  });

  it('reports 0%, not null, for a bucket that ran and was missed', () => {
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('Skipped it', { Shadowfront: { att: 0, opp: 3, exc: 0 } })
    ]), DEFAULT_EVENT_COEFFS);

    expect(rows[0].buckets[0].rate).toBe(0);
    expect(rows[0].reliability).toBe(0);
  });

  it('gives a member with nothing at all a null reliability and sorts them last', () => {
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('Unmeasured', {}),
      member('Absent', { SvS: { att: 0, opp: 2, exc: 0 } })
    ]), DEFAULT_EVENT_COEFFS);

    // Unmeasured is not worse than Absent -- it is not comparable. Mixing it
    // in at 0% would tell the admin to chase someone who was never asked.
    expect(byPseudo(rows).Unmeasured.reliability).toBeNull();
    expect(byPseudo(rows).Absent.reliability).toBe(0);
    expect(rows[rows.length - 1].pseudo).toBe('Unmeasured');
  });
});

describe('the trend only speaks when it has something to compare', () => {
  const withTrend = (recent, prior) => StatsService.computeReliabilityLeaderboard(
    payload(
      [member('T', { SvS: { att: 1, opp: 1, exc: 0 } }, { trend: { recent, prior } })],
      { weeks_recent: 4, weeks_prior: 4 }
    ),
    DEFAULT_EVENT_COEFFS
  )[0].trend;

  it('reports a decline when both windows are substantial', () => {
    const t = withTrend(
      { SvS: { att: 1, opp: 4 } },   // 25%
      { SvS: { att: 3, opp: 4 } }    // 75%
    );
    expect(t.eligible).toBe(true);
    expect(t.prior).toBe(75);
    expect(t.recent).toBe(25);
    expect(t.delta).toBe(-50);
  });

  it('stays silent when a window is too thin to mean anything', () => {
    // One SvS on each side: weighted opportunity 5, below the floor. A single
    // missed event would otherwise read as a 100-point collapse.
    const t = withTrend({ SvS: { att: 0, opp: 1 } }, { SvS: { att: 1, opp: 1 } });
    expect(MIN_TREND_OPPORTUNITIES).toBeGreaterThan(5);
    expect(t.eligible).toBe(false);
    expect(t.delta).toBeNull();
  });

  it('stays silent when the member was not there for the earlier window', () => {
    // A recruit has no prior side. Without this guard they read as a collapse
    // on their first month, which is the opposite of the truth.
    const t = withTrend({ SvS: { att: 2, opp: 4 } }, {});
    expect(t.eligible).toBe(false);
    expect(t.prior).toBeNull();
  });

  it('stays silent when the RPC was not asked for a trend at all', () => {
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('NoTrend', { SvS: { att: 1, opp: 2, exc: 0 } })
    ]), DEFAULT_EVENT_COEFFS);
    expect(rows[0].trend.eligible).toBe(false);
    expect(rows[0].trend.delta).toBeNull();
  });
});

describe('the row carries its own evidence', () => {
  it('exposes the weighted numerator and denominator behind the percentage', () => {
    // A rate without its n is not checkable: 4/4 and 58/62 both look like
    // "about 95%" and they are not the same claim.
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('A', { SvS: { att: 1, opp: 2, exc: 0 }, DTR: { att: 2, opp: 2, exc: 0 } })
    ]), DEFAULT_EVENT_COEFFS);

    expect(rows[0].weighted_att).toBe(5 * 1 + 2 * 2);   // 9
    expect(rows[0].weighted_opp).toBe(5 * 2 + 2 * 2);   // 14
    expect(rows[0].reliability).toBeCloseTo(64.3, 1);
  });

  it('orders buckets by weight, so the events that matter are read first', () => {
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('A', {
        'Arms Race': { att: 1, opp: 1, exc: 0 },
        DTR: { att: 1, opp: 1, exc: 0 },
        SvS: { att: 1, opp: 1, exc: 0 },
        Shadowfront: { att: 1, opp: 1, exc: 0 }
      })
    ]), DEFAULT_EVENT_COEFFS);

    expect(rows[0].buckets.map((b) => b.bucket)).toEqual(['SvS', 'Shadowfront', 'DTR', 'Arms Race']);
  });

  it('keeps the excused count visible even though it left the denominator', () => {
    // The SQL removes excused sessions from opp; the count still travels so
    // the admin can see why a denominator is smaller than their neighbour's.
    const rows = StatsService.computeReliabilityLeaderboard(payload([
      member('A', { SvS: { att: 1, opp: 1, exc: 2 } })
    ]), DEFAULT_EVENT_COEFFS);

    expect(rows[0].buckets[0].exc).toBe(2);
    expect(rows[0].buckets[0].opp).toBe(1);
    expect(rows[0].reliability).toBe(100);
  });
});
