/**
 * src/modules/badges/badges-view.ts
 *
 * ES Module TypeScript implementation of Badges and Veteran Tiers.
 */

export interface PlayerBadgeData {
  role?: string;
  created_at?: string;
  overall_power?: number;
  attended?: number;
  glory_best?: number;
}

export class BadgesView {
  public static computeBadges(data: PlayerBadgeData): string[] {
    const badges: string[] = [];
    if (data.role === 'R5') badges.push('Leader');
    if (data.role === 'R4') badges.push('Officer');
    if ((data.attended || 0) >= 20) badges.push('Veteran');
    if ((data.overall_power || 0) >= 100_000_000) badges.push('Titan');
    if ((data.glory_best || 0) >= 50_000_000) badges.push('Champion');
    return badges;
  }
}
