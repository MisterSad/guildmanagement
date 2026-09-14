/**
 * src/modules/members/members.service.ts
 *
 * Bulk member role helpers, matchup roster sharing to Discord, and the
 * bug-report description formatter, ported from gm-utils.js.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { formatPower } from '../../core/utils/text';
import { APP_VERSION } from '../../core/config/constants';
import { getGuildConfig, setGuildConfig } from '../../core/config/guild-config';
import { getClient } from '../../core/api/supabase';
import { detectClientEnvironment, getActiveGuild } from '../../core/auth/roles';
import { showToast } from '../../core/dom/toast';

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

/**
 * Shares an opponent/target roster to Discord (chunked at 1850 chars), via the
 * webhook proxy with a direct-fetch fallback. Returns true if any chunk posted.
 */
export async function shareMatchupRosterToDiscord(options: {
  title?: string;
  eventPrefix?: string;
  rows?: any[];
  targetLabel?: string;
  webhookUrl?: string;
}): Promise<boolean> {
  const o = options || {};
  const title = o.title || 'Target Roster';
  const eventPrefix = o.eventPrefix || 'svs';
  const rows = o.rows || [];
  const targetLabel = o.targetLabel || 'Target';

  if (!rows || rows.length === 0) {
    showToast('No players in roster to share.', 'warning');
    return false;
  }

  let webhookUrl = (o.webhookUrl && o.webhookUrl.trim()) ? o.webhookUrl.trim() : null;
  if (!webhookUrl) webhookUrl = await getGuildConfig('webhook_' + eventPrefix + '_opponent');
  if (!webhookUrl || !webhookUrl.trim()) {
    const w = (typeof window !== 'undefined' ? window : {}) as any;
    const inputUrl = w.prompt ? w.prompt('No dedicated ' + eventPrefix.toUpperCase() + ' Opponent Discord Webhook URL configured. Please enter Webhook URL:') : null;
    if (!inputUrl || !inputUrl.trim()) return false;
    webhookUrl = inputUrl.trim();
    try {
      await setGuildConfig('webhook_' + eventPrefix + '_opponent', webhookUrl);
    } catch (_) { /* best-effort save */ }
  }
  webhookUrl = webhookUrl!.trim().replace(/^[<"'\s]+|[>'"\s]+$/g, '');
  if (webhookUrl.indexOf('http') !== 0) webhookUrl = 'https://' + webhookUrl;

  let totalPower = 0;
  let extremeCount = 0;
  let highCount = 0;

  rows.forEach((r) => {
    totalPower += (r.power || 0);
    const tier = String(r.danger_tier || '').toUpperCase();
    if (tier === 'EXTREME') extremeCount++;
    if (tier === 'HIGH') highCount++;
  });

  const highPlusCount = extremeCount + highCount;

  const headerText = '⚔️ **' + title + ' — ' + targetLabel + '**\n' +
    '📊 **Players:** ' + rows.length + ' | 💥 **Total Power:** ' + formatPower(totalPower) + ' | ⚠️ **Threats (High+):** ' + highPlusCount + '\n\n' +
    '**Member** | **Guild** | **Power** | **Threat**\n' +
    '----------------------------------------\n';

  const playerLines = rows.map((r, idx) => {
    const tier = String(r.danger_tier || '').toUpperCase();
    let threatBadge = '🟢 LOW';
    if (tier === 'EXTREME') threatBadge = '🔴 EXTREME';
    else if (tier === 'HIGH') threatBadge = '🟠 HIGH';
    else if (tier === 'MEDIUM') threatBadge = '🟡 MEDIUM';
    return '#' + (idx + 1) + ' `' + (r.pseudo || '') + '` | `' + (r.guild || '') + '` | ' + formatPower(r.power || 0) + ' | ' + threatBadge;
  });

  const chunks: string[] = [];
  let currentChunk = headerText;
  for (let i = 0; i < playerLines.length; i++) {
    const line = playerLines[i] + '\n';
    if (currentChunk.length + line.length > 1850) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk += line;
    }
  }
  if (currentChunk.trim().length > 0) chunks.push(currentChunk);

  let successCount = 0;
  let lastErrReason = '';
  const currentG = getActiveGuild();

  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    let posted = false;
    const client = getClient();
    if (client && client.functions && typeof client.functions.invoke === 'function') {
      try {
        const invokeRes = await client.functions.invoke('discord-webhook-proxy', {
          body: {
            eventPrefix: eventPrefix + '_opponent',
            guild: currentG,
            allowEveryoneMention: true,
            payload: { content: chunks[cIdx] }
          }
        });
        if (invokeRes && invokeRes.data && invokeRes.data.ok) posted = true;
        else if (invokeRes && invokeRes.data && invokeRes.data.error) lastErrReason = invokeRes.data.error;
        else if (invokeRes && invokeRes.error) lastErrReason = (invokeRes.error.message || String(invokeRes.error));
      } catch (eProxy) {
        console.warn('Edge Function proxy invoke failed, trying direct fetch fallback:', eProxy);
      }
    }

    if (!posted) {
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: chunks[cIdx] })
        });
        if (res.ok || res.status === 204 || res.status === 200) posted = true;
        else {
          let errBody = '';
          try { errBody = await res.text(); } catch (e) { /* ignore */ }
          lastErrReason = 'HTTP ' + res.status + ' ' + (res.statusText || '') + (errBody ? ': ' + errBody : '');
        }
      } catch (err: any) {
        lastErrReason = (err && err.message) || lastErrReason || 'Network/CORS error';
      }
    }

    if (posted) successCount++;
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
  }

  if (successCount > 0) {
    showToast('Target roster shared to Discord successfully! (' + successCount + ' message' + (successCount > 1 ? 's' : '') + ')', 'success');
    return true;
  }
  showToast('Failed to post roster to Discord: ' + (lastErrReason || 'Unknown error'), 'error');
  return false;
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
