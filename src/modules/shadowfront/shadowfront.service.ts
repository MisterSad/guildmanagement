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
