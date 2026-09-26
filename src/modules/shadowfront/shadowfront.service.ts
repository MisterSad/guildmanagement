/**
 * src/modules/shadowfront/shadowfront.service.ts
 *
 * ES Module TypeScript service managing Shadowfront Squad 1 and Squad 2
 * roster compositions, commanders, and mutual exclusion checks.
 */

export interface ShadowfrontAssignment {
  pseudo: string;
  squad: 'squad1' | 'squad2';
  role: 'participant' | 'reserve';
  is_commander?: boolean;
}

export class ShadowfrontService {
  public static validateSquadExclusion(
    assignments: ShadowfrontAssignment[],
    candidatePseudo: string,
    targetSquad: 'squad1' | 'squad2'
  ): { valid: boolean; reason?: string } {
    const existing = assignments.find((a) => a.pseudo === candidatePseudo);
    if (!existing) return { valid: true };

    if (existing.squad !== targetSquad) {
      return {
        valid: false,
        reason: `Member ${candidatePseudo} is already assigned to ${existing.squad.toUpperCase()} and cannot be in ${targetSquad.toUpperCase()}.`
      };
    }

    return { valid: true };
  }

  public static sortRosterByPower(
    members: Array<{ pseudo: string; overall_power: number; is_commander?: boolean }>
  ): Array<{ pseudo: string; overall_power: number; is_commander?: boolean }> {
    return members.slice().sort((a, b) => {
      if (a.is_commander && !b.is_commander) return -1;
      if (!a.is_commander && b.is_commander) return 1;
      return (b.overall_power || 0) - (a.overall_power || 0);
    });
  }
}

// ── Shadowfront domain constants & pure helpers ───────────────────────────────

export const SHADOWFRONT_EVENT_NAME = 'Shadowfront';
export const SHADOWFRONT_SQUAD_EVENT = {
  squad1: 'Shadowfront Squad 1',
  squad2: 'Shadowfront Squad 2'
} as const;
export const SHADOWFRONT_PARTICIPANTS_MAX = 20;
export const SHADOWFRONT_RESERVES_MAX = 10;
/**
 * B1: the commander cap was an inline `3` in ShadowfrontView, enforced with a
 * hardcoded English sentence while its two sibling limits were named constants
 * with a translated message. Named here so all three squad limits live in one
 * place and read the same way.
 */
export const SHADOWFRONT_COMMANDERS_MAX = 3;

export type ShadowfrontSquadKey = 'squad1' | 'squad2';
export type ShadowfrontRole = 'participant' | 'reserve';
export type ShadowfrontCategory = 'excellent' | 'good' | 'average' | 'poor' | 'none';

export interface ShadowfrontHistory {
  assigned: number;
  participated: number;
  excused_count: number;
  late_count: number;
  sub_present_count: number;
}

export interface ShadowfrontAssignmentRow {
  pseudo: string;
  squad: ShadowfrontSquadKey;
  role: ShadowfrontRole;
  is_commander?: boolean;
  session_id?: string | null;
  guild?: string;
  week_start?: string;
  [key: string]: unknown;
}

export interface ShadowfrontParticipantRow {
  pseudo?: string;
  session_id?: string | null;
  participated?: number | string | null;
  excused?: boolean;
  late?: boolean;
  sub_present?: boolean;
  guild?: string;
  week_start?: string;
  [key: string]: unknown;
}

export interface ShadowfrontMemberRow {
  pseudo: string;
  uid?: string;
  overall_power?: number | string | null;
  [key: string]: unknown;
}

export interface ShadowfrontCategoryMeta {
  labelKey: string;
  cls: ShadowfrontCategory;
  icon: string;
}

export interface ShadowfrontDiscordSquadField {
  participantsCount: number;
  reservesCount: number;
  participantsText: string;
  reservesText: string;
}

export function emptyShadowfrontHistory(): ShadowfrontHistory {
  return { assigned: 0, participated: 0, excused_count: 0, late_count: 0, sub_present_count: 0 };
}

/** Port of shadowfront.js#categorise (rate > .8 excellent, >=.5 good, >=.2 average, else poor). */
export function categoriseHistory(h?: ShadowfrontHistory): ShadowfrontCategory {
  if (!h || h.assigned === 0) return 'none';
  const rate = h.participated / h.assigned;
  if (rate > 0.8) return 'excellent';
  if (rate >= 0.5) return 'good';
  if (rate >= 0.2) return 'average';
  return 'poor';
}

/** Port of shadowfront.js#categoryMeta (label key resolved by the view via GM.t). */
export function categoryMeta(cat: ShadowfrontCategory): ShadowfrontCategoryMeta {
  if (cat === 'excellent') return { labelKey: 'sf_filter_excellent', cls: 'excellent', icon: '🟢' };
  if (cat === 'good') return { labelKey: 'sf_filter_good', cls: 'good', icon: '🔵' };
  if (cat === 'average') return { labelKey: 'sf_filter_average', cls: 'average', icon: '🟡' };
  if (cat === 'poor') return { labelKey: 'sf_filter_poor', cls: 'poor', icon: '🔴' };
  return { labelKey: 'sf_filter_none', cls: 'none', icon: '⚫' };
}

/** Port of shadowfront.js#countRate. */
export function countRate(
  pseudos: string[],
  category: ShadowfrontCategory,
  historyOf: (pseudo: string) => ShadowfrontHistory | undefined
): number {
  let n = 0;
  pseudos.forEach((p) => { if (categoriseHistory(historyOf(p)) === category) n++; });
  return n;
}

/** Port of shadowfront.js#sortSquadList (commanders first, then descending power). */
export function sortSquadList(
  list: ShadowfrontAssignmentRow[],
  powerOf: (pseudo: string) => number
): ShadowfrontAssignmentRow[] {
  return list.slice().sort((a, b) => {
    const isCmdA = !!a.is_commander;
    const isCmdB = !!b.is_commander;
    if (isCmdA && !isCmdB) return -1;
    if (!isCmdA && isCmdB) return 1;
    return powerOf(b.pseudo) - powerOf(a.pseudo);
  });
}

/**
 * Port of the history aggregation block in shadowfront.js#loadShadowfront
 * (lines 154-206): union of (pseudo, session_id) pairs from shadowfront_squads
 * and event_participants for any non-active, started session.
 */
export function aggregateShadowfrontHistory(params: {
  histSquads: Array<{ pseudo?: string; session_id?: string | null }>;
  histParts: ShadowfrontParticipantRow[];
  activeSessionIds: string[];
  startedSessions: Record<string, boolean>;
}): Record<string, ShadowfrontHistory> {
  const { histSquads, histParts, activeSessionIds, startedSessions } = params;

  const partMap: Record<string, { participated: number; excused: boolean; sub_present: boolean; late: boolean }> = {};
  histParts.forEach((r) => {
    partMap[(r.pseudo || '') + '|' + (r.session_id || '')] = {
      participated: Number(r.participated) || 0,
      excused: !!r.excused,
      sub_present: !!r.sub_present,
      late: !!r.late
    };
  });

  const histKeys: Record<string, boolean> = {};
  histSquads.forEach((r) => {
    if (activeSessionIds.indexOf(r.session_id || '') !== -1) return;
    if (!startedSessions[r.session_id || '']) return;
    histKeys[(r.pseudo || '') + '|' + (r.session_id || '')] = true;
  });
  histParts.forEach((r) => {
    if (activeSessionIds.indexOf(r.session_id || '') !== -1) return;
    histKeys[(r.pseudo || '') + '|' + (r.session_id || '')] = true;
  });

  const hist: Record<string, ShadowfrontHistory> = {};
  Object.keys(histKeys).forEach((key) => {
    const idx = key.indexOf('|');
    const pseudo = key.substring(0, idx);
    if (!hist[pseudo]) hist[pseudo] = emptyShadowfrontHistory();

    const partInfo = partMap[key];
    if (partInfo) {
      if (partInfo.excused) {
        hist[pseudo].excused_count++;
      } else if (partInfo.sub_present) {
        hist[pseudo].assigned++;
        hist[pseudo].participated++; // Reserve present = valid participation
        hist[pseudo].sub_present_count++;
      } else {
        hist[pseudo].assigned++;
        if (partInfo.participated > 0) hist[pseudo].participated++;
        if (partInfo.late) hist[pseudo].late_count++;
      }
    } else {
      hist[pseudo].assigned++;
    }
  });

  return hist;
}

/** Port of shadowfront.js#discordEscape. */
export function discordEscape(value: unknown): string {
  return String(value || '').replace(/([*_~`>])/g, '\\$1');
}

/** Port of the participant/reserve list formatting inside shadowfront.js#shareCompositionOnDiscord. */
export function formatSquadCompositionField(
  members: ShadowfrontAssignmentRow[]
): ShadowfrontDiscordSquadField {
  const fmtList = (list: ShadowfrontAssignmentRow[]): { count: number; text: string } => {
    if (list.length === 0) return { count: 0, text: 'None yet' };
    const seen: Record<string, boolean> = {};
    const uniqueList: ShadowfrontAssignmentRow[] = [];
    list.forEach((a) => {
      if (!seen[a.pseudo]) {
        seen[a.pseudo] = true;
        uniqueList.push(a);
      }
    });
    const str = uniqueList.map((a) => (a.is_commander ? '👑 ' : '') + discordEscape(a.pseudo)).join('\n');
    const formattedText = str.length > 1024 ? str.substring(0, 1020) + '...' : str;
    return { count: uniqueList.length, text: formattedText };
  };

  const participantsRes = fmtList(members.filter((a) => a.role === 'participant'));
  const reservesRes = fmtList(members.filter((a) => a.role === 'reserve'));

  return {
    participantsCount: participantsRes.count,
    reservesCount: reservesRes.count,
    participantsText: participantsRes.text,
    reservesText: reservesRes.text
  };
}

/** Port of the Discord webhook payload built in shadowfront.js#shareCompositionOnDiscord. */
export function buildShadowfrontDiscordPayload(params: {
  squadLabel: string;
  squad: ShadowfrontDiscordSquadField;
  roleMention: string;
  participantsLabel: string;
  reservesLabel: string;
  participantsMax?: number;
  reservesMax?: number;
}): Record<string, unknown> {
  const {
    squadLabel,
    squad,
    roleMention,
    participantsLabel,
    reservesLabel,
    participantsMax = SHADOWFRONT_PARTICIPANTS_MAX,
    reservesMax = SHADOWFRONT_RESERVES_MAX
  } = params;

  const content = '📋 **Shadowfront - ' + squadLabel + ' Composition**' + (roleMention ? ' ' + roleMention : '');

  return {
    content: content,
    allowed_mentions: { parse: ['roles', 'users', 'everyone'] },
    embeds: [
      {
        title: squadLabel,
        color: 9442302, // Lilac (#8B5CF6)
        fields: [
          {
            name: participantsLabel + ' (' + squad.participantsCount + '/' + participantsMax + ')',
            value: squad.participantsText || 'None yet',
            inline: true
          },
          {
            name: reservesLabel + ' (' + squad.reservesCount + '/' + reservesMax + ')',
            value: squad.reservesText || 'None yet',
            inline: true
          }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'FGF Guild Management Tool' }
      }
    ]
  };
}
