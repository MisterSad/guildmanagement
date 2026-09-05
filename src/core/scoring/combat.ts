/**
 * src/core/scoring/combat.ts
 *
 * Tactical military scoring, rally metrics, power tiers, and combat density formulas.
 * Extracted from gm-utils.js as part of Ticket 3.2 modularization.
 */

export interface CombatMemberMetrics {
  overall_power?: number | string | null;
  total_power?: number | string | null;
  flagship_power?: number | string | null;
  fleet_rating?: number | string | null;
  tech_power?: number | string | null;
  crew_power?: number | string | null;
  champion_power?: number | string | null;
  glory_score?: number | string | null;
  glory?: number | string | null;
  [key: string]: unknown;
}

export interface RallyRoleMeta {
  isLeader: boolean;
  rank: number;
  label: string;
  type: 'leader' | 'joiner';
}

export type PowerTier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface PowerTierMeta {
  cls: string;
  label: string;
  color: string;
  icon: string;
}

export const COMBAT_WEIGHTS = {
  FLEET: 80.0,
  FLAGSHIP: 18.0,
  CREW: 8.0,
  TECH: 6.0,
  CHAMPION: 0.8,
  GLORY: 0.05
} as const;

export function parseSafeMetric(val: unknown): number {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) || val < 0 ? 0 : val;
  const cleaned = String(val).replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) || n < 0 ? 0 : n;
}

export function calculateCombatDensity(m?: CombatMemberMetrics | null): number {
  if (!m) return 0;
  const tot = parseSafeMetric(m.overall_power || m.total_power);
  if (tot <= 0) return 0;
  const flag = parseSafeMetric(m.flagship_power);
  const fleet = parseSafeMetric(m.fleet_rating);
  const tech = parseSafeMetric(m.tech_power);
  const crew = parseSafeMetric(m.crew_power);
  const champ = parseSafeMetric(m.champion_power);
  const glory = parseSafeMetric(m.glory_score || m.glory);

  // Scaled combat density based on natural metric orders of magnitude:
  // Fleet (80.0x) > Flagship (18.0x) > Crew (8.0x) > Tech (6.0x) > Champs (0.8x) > Glory (0.05x)
  const weightedCombat =
    fleet * COMBAT_WEIGHTS.FLEET +
    flag * COMBAT_WEIGHTS.FLAGSHIP +
    crew * COMBAT_WEIGHTS.CREW +
    tech * COMBAT_WEIGHTS.TECH +
    champ * COMBAT_WEIGHTS.CHAMPION +
    glory * COMBAT_WEIGHTS.GLORY;

  return Math.round((weightedCombat / tot) * 1000) / 10;
}

export function calculateRallyScore(m?: CombatMemberMetrics | null): number {
  if (!m) return 0;
  const tot = parseSafeMetric(m.overall_power || m.total_power);
  const flag = parseSafeMetric(m.flagship_power);
  const fleet = parseSafeMetric(m.fleet_rating);
  const tech = parseSafeMetric(m.tech_power);
  const crew = parseSafeMetric(m.crew_power);
  const champ = parseSafeMetric(m.champion_power);
  const glory = parseSafeMetric(m.glory_score || m.glory);

  // Absolute composite rally combat readiness score (scale-normalized)
  return Math.round(
    tot +
      fleet * COMBAT_WEIGHTS.FLEET +
      flag * COMBAT_WEIGHTS.FLAGSHIP +
      crew * COMBAT_WEIGHTS.CREW +
      tech * COMBAT_WEIGHTS.TECH +
      champ * COMBAT_WEIGHTS.CHAMPION +
      glory * COMBAT_WEIGHTS.GLORY
  );
}

export function calculateRallyGrade(m?: CombatMemberMetrics | null, maxScore?: number | null): number {
  if (!m) return 0;
  const score = calculateRallyScore(m);
  if (score <= 0) return 0;
  if (!maxScore || maxScore <= 0) return 100;
  const grade = Math.round((score / maxScore) * 100);
  return Math.min(100, Math.max(0, grade));
}

export function calculateResidualPower(m?: CombatMemberMetrics | null): number {
  if (!m) return 0;
  const tot = parseSafeMetric(m.overall_power || m.total_power);
  const tech = parseSafeMetric(m.tech_power);
  const champ = parseSafeMetric(m.champion_power);
  const crew = parseSafeMetric(m.crew_power);
  return Math.max(0, tot - (tech + champ + crew));
}

export function calculateCombativity(m?: CombatMemberMetrics | null): number {
  if (!m) return 0;
  const tot = parseSafeMetric(m.overall_power || m.total_power);
  if (tot <= 0) return 0;
  const glory = parseSafeMetric(m.glory_score || m.glory);
  return Math.round((glory / tot) * 100) / 100;
}

export function calculateWarScore(m?: CombatMemberMetrics | null): number {
  return calculateRallyScore(m);
}

export function getRallyRoleMeta(rank?: number | null, score?: number | null): RallyRoleMeta {
  if (!score || score <= 0 || (rank != null && rank > 16)) {
    return { isLeader: false, rank: rank || 999, label: 'Rally Joiner', type: 'joiner' };
  }
  return { isLeader: true, rank: rank || 1, label: 'Rally Leader #' + rank, type: 'leader' };
}

export function getPowerTier(power?: number | string | null, maxPower?: number | string | null): PowerTier {
  if (!power) return 'D';
  const p = typeof power === 'number' ? power : parseInt(String(power), 10) || 0;
  const m = typeof maxPower === 'number' ? maxPower : parseInt(String(maxPower), 10) || 0;
  if (m <= 0) return 'D';
  const pct = p / m;
  if (pct >= 0.8) return 'S';
  if (pct >= 0.6) return 'A';
  if (pct >= 0.4) return 'B';
  if (pct >= 0.2) return 'C';
  return 'D';
}

export function getPowerTierMeta(tier?: string | null): PowerTierMeta {
  if (tier === 'S') return { cls: 'tier-s', label: 'Mythic', color: 'var(--accent)', icon: '👑' };
  if (tier === 'A') return { cls: 'tier-a', label: 'Legendary', color: '#ef4444', icon: '🔥' };
  if (tier === 'B') return { cls: 'tier-b', label: 'Epic', color: '#f97316', icon: '💎' };
  if (tier === 'C') return { cls: 'tier-c', label: 'Rare', color: '#3b82f6', icon: '⭐' };
  return { cls: 'tier-d', label: 'Common', color: 'var(--text-muted)', icon: '🛡️' };
}
