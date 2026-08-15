/**
 * src/modules/stats/stats.service.ts
 *
 * ES Module TypeScript service managing participation rate calculations,
 * distinct scoring key aggregation, period filtering (8w, 4w, 1w), and CSV export generation.
 */

import { eventScoringKey } from '../../core/config/events';

export interface ParticipationRecord {
  pseudo: string;
  eventName: string;
  sessionId: string;
  weekStart?: string;
  attended: boolean;
  score?: number;
  scorePrep?: number;
  scorePvp?: number;
}

export type PeriodFilter = 'all' | '8w' | '4w' | '1w';

export class StatsService {
  public static filterRecordsByPeriod(
    records: ParticipationRecord[],
    period: PeriodFilter
  ): ParticipationRecord[] {
    const weeksMap: Record<PeriodFilter, number | null> = {
      all: null,
      '8w': 8,
      '4w': 4,
      '1w': 1
    };

    const weeks = weeksMap[period];
    if (weeks === null) return records;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7 * weeks);

    return records.filter((r) => {
      if (!r.weekStart) return true;
      const d = new Date(r.weekStart + 'T00:00:00');
      return !isNaN(d.getTime()) && d >= cutoff;
    });
  }

  /**
   * Calculates the distinct scoring key attendance rate for a player,
   * excluding weekly Glory power tracking.
   */
  public static calculateDistinctAttendanceRate(
    playerRecords: ParticipationRecord[],
    allTenantRecords: ParticipationRecord[]
  ): { attendedCount: number; totalCount: number; rate: number } {
    // 1. Determine all unique event scoring instances across the tenant (Glory excluded)
    const tenantKeys = new Set<string>();
    allTenantRecords.forEach((r) => {
      if ((r.eventName || '').toLowerCase() === 'glory') return;
      const key = eventScoringKey(r.eventName, r.sessionId, r.weekStart);
      if (key) tenantKeys.add(key);
    });
    const totalCount = tenantKeys.size;

    // 2. Determine unique scoring instances attended by this player
    const attendedKeys = new Set<string>();
    playerRecords.forEach((r) => {
      if ((r.eventName || '').toLowerCase() === 'glory') return;
      const isAttended =
        r.attended ||
        (r.score && r.score > 0) ||
        (r.scorePrep && r.scorePrep > 0) ||
        (r.scorePvp && r.scorePvp > 0);
      if (isAttended) {
        const key = eventScoringKey(r.eventName, r.sessionId, r.weekStart);
        if (key) attendedKeys.add(key);
      }
    });
    const attendedCount = attendedKeys.size;
    const rate = totalCount > 0 ? Math.round((attendedCount / totalCount) * 100) : 0;

    return { attendedCount, totalCount, rate };
  }

  public static calculateMemberAttendanceRate(records: ParticipationRecord[]): number {
    if (!records || records.length === 0) return 0;
    const attended = records.filter((r) => r.attended).length;
    return Math.round((attended / records.length) * 100);
  }

  public static generateCSVReport(
    headers: string[],
    rows: Array<Array<string | number | boolean>>
  ): string {
    const headerLine = headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(',');
    const bodyLines = rows.map((row) =>
      row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
    );
    return [headerLine, ...bodyLines].join('\n');
  }
}
