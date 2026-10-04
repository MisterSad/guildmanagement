/**
 * src/modules/events/pending-approval.ts
 *
 * The "Pending → Approve" control for a player's own Player Portal submission,
 * for the event views that had none: Arms Race and Shadowfront.
 *
 * A submitted row carries `is_pending = true`, and every stats RPC excludes
 * pending rows (`coalesce(ep.is_pending, false) = false`). Without a way to
 * approve it, a submission on those two events would stay out of the stats
 * forever. Approval goes through the same SECURITY DEFINER RPC the SvS / GvG /
 * DTR page uses.
 */

import { escapeHTML } from '../../core/utils/text';

export interface PendingApprovalContext {
  db: any;
  guild: string;
  /** The participant rows' event_name ("Shadowfront", "ARMS RACE STAGE A"). */
  eventName: string;
  sessionId: string;
  showToast: (msg: string, type: string) => void;
}

/** Chip + button, or nothing when the row is not pending. */
export function pendingApprovalHtml(pseudo: string | undefined, isPending: unknown): string {
  if (!isPending || !pseudo) return '';
  return (
    '<span class="gm-chip gm-chip-warning" style="font-size: var(--fs-2xs); padding:0.05rem 0.3rem;" title="Submitted by the player from the Player Portal">Pending</span>' +
    '<button type="button" class="gm-btn gm-btn-success gm-btn-sm pending-approve-btn" data-pseudo="' +
    escapeHTML(pseudo) +
    '" style="padding:0.1rem 0.45rem; font-size: var(--fs-xs);">Approve</button>'
  );
}

/** Wire every `.pending-approve-btn` under `area`. `onApproved` runs after a success. */
export function wirePendingApprovals(
  area: Element,
  ctx: PendingApprovalContext,
  onApproved: (pseudo: string) => void
): void {
  area.querySelectorAll('.pending-approve-btn').forEach((el) => {
    const btn = el as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      const pseudo = btn.getAttribute('data-pseudo') || '';
      btn.disabled = true;
      try {
        const res = await ctx.db.rpc('gm_approve_participant_submission', {
          p_guild: ctx.guild,
          p_event_name: ctx.eventName,
          p_session_id: ctx.sessionId,
          p_pseudo: pseudo,
        });
        if (res.error) throw res.error;
        if (!res.data || res.data.ok === false) throw new Error((res.data && res.data.error) || 'approve_failed');
        onApproved(pseudo);
      } catch (err) {
        console.error('approve submission', err);
        ctx.showToast('Failed to approve submission.', 'error');
        btn.disabled = false;
      }
    });
  });
}
