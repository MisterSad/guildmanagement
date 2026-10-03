/**
 * src/modules/members/members.service.ts
 *
 * Bulk member role helpers and the bug-report description formatter, ported
 * from gm-utils.js.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { APP_VERSION } from '../../core/config/constants';
import { detectClientEnvironment } from '../../core/auth/roles';

const ALLOWED_BULK_ROLES = ['R1', 'R2', 'R3', 'R4'];

export function getAllowedBulkRoles(): string[] {
  return ALLOWED_BULK_ROLES.slice();
}

export function isRoleAllowedForBulk(role: string): boolean {
  return ALLOWED_BULK_ROLES.indexOf(role) !== -1;
}

export interface BulkEligibleResult {
  eligiblePseudos: string[];
  excludedR5Count: number;
}

/**
 * Filters selected pseudos against the roster: keeps existing members and
 * excludes any R5 (guild leadership is protected).
 */
export function filterBulkEligibleMembers(
  members: Array<{ pseudo?: string; role?: string }> | null | undefined,
  selectedPseudos: string[] | Set<string> | null | undefined
): BulkEligibleResult {
  const list = members || [];
  const selArr = Array.isArray(selectedPseudos)
    ? selectedPseudos
    : (selectedPseudos && typeof (selectedPseudos as any).forEach === 'function' ? Array.from(selectedPseudos as Set<string>) : []);

  const selSet: Record<string, boolean> = {};
  selArr.forEach((p) => { if (p) selSet[String(p).toLowerCase()] = true; });

  const eligible: string[] = [];
  let excludedR5 = 0;

  list.forEach((m) => {
    if (!m || !m.pseudo) return;
    if (selSet[m.pseudo.toLowerCase()]) {
      if (m.role === 'R5') excludedR5++;
      else eligible.push(m.pseudo);
    }
  });

  return { eligiblePseudos: eligible, excludedR5Count: excludedR5 };
}

export interface TicketDescriptionSections {
  currentBehavior?: string;
  expectedBehavior?: string;
  steps?: string;
  additionalContext?: string;
  env?: { appVersion?: string; os?: string; browser?: string };
}

/** Formats a bug-report description with an environment footer. */
export function formatTicketDescription(sections: TicketDescriptionSections): string {
  if (!sections || typeof sections !== 'object') return '';
  const parts: string[] = [];

  if (sections.currentBehavior && sections.currentBehavior.trim()) parts.push('**Current Behavior / Issue**\n' + sections.currentBehavior.trim());
  if (sections.expectedBehavior && sections.expectedBehavior.trim()) parts.push('**Expected Behavior**\n' + sections.expectedBehavior.trim());
  if (sections.steps && sections.steps.trim()) parts.push('**Steps to Reproduce**\n' + sections.steps.trim());
  if (sections.additionalContext && sections.additionalContext.trim()) parts.push('**Additional Context / Information**\n' + sections.additionalContext.trim());

  const env = sections.env || detectClientEnvironment();
  parts.push(
    '**Environment**\n' +
    '• FGF Mgmt Tool Version: ' + (env.appVersion || APP_VERSION) + '\n' +
    '• OS + Version: ' + (env.os || 'Unknown OS') + '\n' +
    '• Browser + Version: ' + (env.browser || 'Unknown Browser')
  );

  return parts.join('\n\n');
}
