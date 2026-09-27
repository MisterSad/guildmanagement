/**
 * src/core/scoring/reliability.ts
 *
 * The weighted attendance rate, defined once.
 *
 *     reliability = 100 * SUM_b coeff(b) * attended(b) / SUM_b coeff(b) * opportunities(b)
 *
 * This lives in `core/` rather than in the Stats module because two different
 * screens publish it to two different audiences: the admin Stats page and the
 * player Portal. They used to answer differently for the same member on the
 * same day -- measured on ALPHA, the Portal told players their guild attended
 * 48.1% while Stats told the admin 31.6%, because the Portal counted rows
 * rather than sessions and included Glory (100% "participated" by
 * construction) and rows still awaiting approval.
 *
 * A number a guild leader and a guild member read differently is worse than no
 * number at all, so there is one implementation and both import it.
 * `core/` never imports `modules/`, which is what keeps it reachable from both.
 */

import { DEFAULT_EVENT_COEFFS, type EventCoeffs, type EventCoeffBucket } from '../config/event-coeffs';

/** Counts for one event bucket. `opp` is the denominator that already applies. */
export interface BucketCounts {
  att: number;
  opp: number;
}

export interface WeightedRate {
  /** 0-100, or null when there were no opportunities at all. */
  rate: number | null;
  /** The weighted numerator and denominator, so a rate always travels with its n. */
  attended: number;
  opportunities: number;
}

/**
 * Maps a bucket label to its coefficient key.
 *
 * The labels ARE event names -- 'SvS', 'Arms Race', or, for anything the
 * scoring key did not recognise, the raw `event_name`. Kept here rather than
 * imported from the Stats module so that `core/` stays self-contained.
 */
export function coeffBucketOf(label?: string): EventCoeffBucket | null {
  const row = (label || '').trim().toLowerCase();
  if (row === 'svs') return 'SvS';
  if (row === 'gvg') return 'GvG';
  if (row.indexOf('shadowfront') !== -1) return 'Shadowfront';
  if (row.indexOf('arms race') !== -1) return 'Arms Race';
  if (row.indexOf('dtr') !== -1 || row.indexOf('defend trade route') !== -1) return 'DTR';
  return null;
}

/**
 * Weights each bucket's rate by the tenant's coefficient for that event type.
 *
 * A bucket with `opp = 0` contributes to neither side: "was never asked" is not
 * "did not attend", and the caller renders it as an em dash rather than 0%.
 * An unrecognised bucket weighs 1, so a new event type counts rather than
 * silently vanishing.
 */
export function weightedRate(
  buckets: Record<string, BucketCounts> | null | undefined,
  coeffs?: EventCoeffs
): WeightedRate {
  const useCoeffs: EventCoeffs = coeffs || DEFAULT_EVENT_COEFFS;
  let attended = 0;
  let opportunities = 0;

  Object.keys(buckets || {}).forEach((label) => {
    const b = (buckets as Record<string, BucketCounts>)[label] || { att: 0, opp: 0 };
    const key = coeffBucketOf(label);
    const coeff = (key && useCoeffs[key] != null) ? useCoeffs[key] : 1;
    attended += coeff * (Number(b.att) || 0);
    opportunities += coeff * (Number(b.opp) || 0);
  });

  return {
    rate: opportunities > 0 ? (attended / opportunities) * 100 : null,
    attended,
    opportunities
  };
}

/** One decimal, matching how every rate in this product is displayed. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
