/**
 * src/core/config/event-coeffs.ts
 *
 * THE default weight of each event type, and the only place it is written down.
 *
 * FINDING B1. The same five numbers used to be declared twice: as a typed record
 * in `modules/stats/stats.service.ts` and again as `coeff_*` strings in
 * `core/config/guild-config.ts`. They happened to agree, so nothing was visibly
 * broken -- which is exactly why a divergence would have gone unnoticed: the
 * stats engine would have weighted events differently from the settings screen
 * that claims to configure it.
 *
 * WHAT THE AUDIT GOT WRONG, recorded so it is not re-filed. It reported these
 * defaults as contradicting the DEMO seed (which writes GvG 3, Shadowfront 2,
 * DTR 1) and concluded three of five values were untrustworthy. Checked against
 * production: DEMO is simply a tenant with its own settings, like BABE (GvG 3)
 * or CLAW (GvG 4, DTR 3, SvS 4). Of the 15 guilds that have configured
 * coefficients, the values below are the majority choice for every single one:
 *
 *     SvS 5 (14/15) · GvG 5 (11/15) · Shadowfront 3 (14/15)
 *     DTR 2 (12/15) · Arms Race 1 (13/15)
 *
 * So these are not arbitrary -- they are what guilds actually pick.
 *
 * WHY THESE ARE NOT SEEDED INTO `guild_config`. The plan proposed migrating them
 * so the database became the only source. The 11 guilds that have never
 * configured coefficients currently FOLLOW this default; writing rows for them
 * would freeze each one and remove the ability to change the default centrally,
 * in exchange for no behavioural difference today. A tenant that wants its own
 * weights sets them, and `getGuildConfig` already prefers the stored value.
 */

export type EventCoeffBucket = 'SvS' | 'GvG' | 'Shadowfront' | 'DTR' | 'Arms Race';

export type EventCoeffs = Record<EventCoeffBucket, number>;

export const DEFAULT_EVENT_COEFFS: EventCoeffs = {
  SvS: 5,
  GvG: 5,
  Shadowfront: 3,
  DTR: 2,
  'Arms Race': 1
};

/** `guild_config` key for each bucket, so the two representations cannot drift. */
export const EVENT_COEFF_CONFIG_KEYS: Record<EventCoeffBucket, string> = {
  SvS: 'coeff_svs',
  GvG: 'coeff_gvg',
  Shadowfront: 'coeff_shadowfront',
  DTR: 'coeff_dtr',
  'Arms Race': 'coeff_armsrace'
};

/** The defaults shaped as the `coeff_*` string entries `guild_config` stores. */
export function defaultCoeffConfigEntries(): Record<string, string> {
  const out: Record<string, string> = {};
  (Object.keys(DEFAULT_EVENT_COEFFS) as EventCoeffBucket[]).forEach((bucket) => {
    out[EVENT_COEFF_CONFIG_KEYS[bucket]] = String(DEFAULT_EVENT_COEFFS[bucket]);
  });
  return out;
}
