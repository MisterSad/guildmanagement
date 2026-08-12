/**
 * src/modules/stats/stats.service.ts
 *
 * ES Module TypeScript service managing participation rate calculations,
 * period filtering (8w, 4w, 1w), and CSV export generation.
 */

export interface ParticipationRecord {
  pseudo: string;
  eventName: string;
  sessionId: string;
  weekStart?: string;
  attended: boolean;
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
