/**
 * src/core/utils/numbers.ts
 *
 * Barrel for numeric parsing/formatting and power-tier helpers. The
 * implementations live next to their domain (text/combat) to avoid duplicating
 * logic; this module is the canonical import path for the numbers domain.
 */

export { parseNumber, formatNumber, formatCompactNumber, formatPower, MAX_NUMERIC } from './text';
export { parseSafeMetric, getPowerTier, getPowerTierMeta } from '../scoring/combat';
export type { PowerTier, PowerTierMeta } from '../scoring/combat';
