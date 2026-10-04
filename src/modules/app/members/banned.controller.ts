/**
 * src/modules/app/members/banned.controller.ts
 *
 * Sous-lot 6.6 (Strangler) — banned players CRUD ported from app.js:
 * fetchBannedPlayers, renderBannedPlayers, handleAddBannedPlayer and
 * deleteBannedPlayer. Strict escaping via esc().
 */

import { t, esc, byId } from '../admin/utils';
import {
  type BannedPlayer,
  getBannedPlayers,
  setBannedPlayers,
  removeBannedPlayer,
  getGuildMembers,
  filterGuildMembersOut,
} from './members.store';
import { renderGuildMembers } from './members.render';
import { showToast, showConfirm } from '../dialogs/dialogs.service';
import { banMember, listBannedPlayers, deleteBannedPlayerRow } from '../../members/members.service';
import { getActiveGuild } from '../../../core/auth/roles';
import { getClient } from '../../../core/api/supabase';
import { getLang } from '../../../core/i18n/i18n';
import { avatarInit, validateUid } from '../../../core/utils/text';

function db(): any {
  return getClient();
}
/**
 * H2: one resolver, shared. This was the third of four independent copies of
 * the restriction -> current -> localStorage -> ALPHA chain.
 */
function activeGuild(): string | null {
  return getActiveGuild();
}

export async function fetchBannedPlayers(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const currentG = activeGuild();
    const res = await listBannedPlayers(client, currentG);
    if (res.error) throw res.error;
    setBannedPlayers(res.data || []);
    renderBannedPlayers();
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

export function renderBannedPlayers(): void {
  const container = byId('banned-list-container');
  if (!container) return;
  const search = byId<HTMLInputElement>('banned-search');
  const q = search ? search.value.toLowerCase() : '';
  const banned = getBannedPlayers();
  const filtered = banned.filter(
    (bp) =>
      (
        String(bp.uid).toLowerCase() +
        ' ' +
        String(bp.pseudo || '').toLowerCase() +
        ' ' +
        String(bp.reason || '').toLowerCase()
      ).indexOf(q) !== -1
  );

  const count = byId('banned-count');
  if (count) count.textContent = String(filtered.length);

  if (filtered.length === 0) {
    container.innerHTML =
      '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' +
      t('empty_banned') +
      '</div></div>';
    return;
  }

  const lang = getLang();
  const locale = lang === 'fr' ? 'fr-FR' : 'en-GB';
  const uidPrefix = t('banned_uid_prefix');
  const reasonLabel = t('banned_reason_label');
  const byLabel = t('banned_by_label');
  const onLabel = t('banned_on_label');
  const fallbackName = t('banned_fallback_name');

  let html = '<div class="gm-member-list">';
  filtered.forEach((bp: BannedPlayer) => {
    const dateStr = bp.created_at
      ? new Date(bp.created_at).toLocaleDateString(locale, {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';
    const initial = avatarInit(bp.pseudo || fallbackName);
    html +=
      '<div class="gm-member-row" data-uid="' +
      esc(bp.uid) +
      '">' +
      '<div class="gm-member-id">' +
      '<div class="u-bg-danger-soft u-c-danger u-bc-danger-soft gm-avatar">' +
      esc(initial) +
      '</div>' +
      '<div class="gm-grow gm-truncate">' +
      '<div class="u-c-danger u-fw-700 u-fs-fs-xl gm-mono gm-truncate">' +
      esc(uidPrefix) +
      ' ' +
      esc(bp.uid) +
      '</div>' +
      '<div class="u-fw-500 u-fs-fs-base u-mt-2px gm-member-pseudo gm-dim gm-truncate">' +
      esc(bp.pseudo || '-') +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="u-gap-0_2rem u-fs-fs-sm u-flex-1_5 u-minw-150px gm-col gm-dim">' +
      '<span><strong>' +
      esc(reasonLabel) +
      '</strong> ' +
      esc(bp.reason || '-') +
      '</span>' +
      '<span>' +
      esc(byLabel) +
      ' <strong>' +
      esc(bp.created_by || '-') +
      '</strong> ' +
      esc(onLabel) +
      ' ' +
      dateStr +
      '</span>' +
      '</div>' +
      '<div class="gm-member-actions">' +
      '<button class="u-c-danger gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm banned-delete-btn" data-uid="' +
      esc(bp.uid) +
      '" title="' +
      t('delete_title') +
      '"><i class="ph ph-trash"></i></button>' +
      '</div>' +
      '</div>';
  });
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.banned-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const uid = btn.getAttribute('data-uid') || '';
      showConfirm(t('confirm_unban_title'), t('confirm_unban_body') + ' <strong>' + esc(uid) + '</strong> ?', () => {
        void deleteBannedPlayer(uid);
      });
    });
  });
}

export async function handleAddBannedPlayer(): Promise<void> {
  const client = db();
  if (!client) return;
  const uidInput = byId<HTMLInputElement>('banned-uid');
  const pseudoInput = byId<HTMLInputElement>('banned-pseudo');
  const reasonInput = byId<HTMLInputElement>('banned-reason');
  const uidVal = uidInput ? uidInput.value.trim() : '';
  const pseudoVal = pseudoInput ? pseudoInput.value.trim() : '';
  const reasonVal = reasonInput ? reasonInput.value.trim() : '';
  if (!uidVal) return;

  const uidErr = validateUid(uidVal);
  if (uidErr) {
    showToast(t(uidErr), 'error');
    return;
  }

  if (getBannedPlayers().some((bp) => bp.uid === uidVal)) {
    showToast(t('toast_player_already_banned'), 'error');
    return;
  }
  // Banning removes the player from the roster, which the database refuses for
  // the R5: the ban would be recorded while the leader stayed on the roster.
  if (getGuildMembers().some((m) => m.uid === uidVal && m.role === 'R5')) {
    showToast('The R5 leader cannot be banned. Change their role first (Members → Edit).', 'warning');
    return;
  }

  // Banning a player on the roster removes them from it, and the roster row
  // carries their history (ON DELETE CASCADE). That used to happen silently.
  const onRoster = getGuildMembers().find((m) => m.uid === uidVal);
  if (onRoster) {
    showConfirm(
      'Ban and remove from the guild',
      '<strong>' +
        esc(onRoster.pseudo) +
        '</strong> is on your member list. Banning removes them from it.<br><br>' +
        '<span class="u-c-hexf87171">' +
        esc(t('confirm_remove_member_cascade')) +
        '</span><br><br>' +
        'To keep a record without losing their history, give a sanction instead.',
      () => executeBan(uidVal, pseudoVal, reasonVal)
    );
    return;
  }
  await executeBan(uidVal, pseudoVal, reasonVal);
}

async function executeBan(uidVal: string, pseudoVal: string, reasonVal: string): Promise<void> {
  const uidInput = byId<HTMLInputElement>('banned-uid');
  const pseudoInput = byId<HTMLInputElement>('banned-pseudo');
  const reasonInput = byId<HTMLInputElement>('banned-reason');
  const form = byId<HTMLFormElement>('add-banned-form');
  const btn = form ? (form.querySelector('button[type="submit"]') as HTMLButtonElement | null) : null;
  if (btn) btn.disabled = true;

  try {
    // The ban and the removal from the roster are one transaction (M4a). The
    // removal used to fail silently and leave the banned player on the
    // roster; the author is now the caller's account, read server-side.
    const res = await banMember(uidVal, pseudoVal || null, reasonVal || null);

    if (uidInput) uidInput.value = '';
    if (pseudoInput) pseudoInput.value = '';
    if (reasonInput) reasonInput.value = '';

    let kickMsg = '';
    if (res.removed) {
      filterGuildMembersOut((m) => m.uid === uidVal);
      renderGuildMembers();
      kickMsg = t('toast_player_banned_kick');
    }

    showToast(t('toast_player_banned_ok') + kickMsg, 'success');
    await fetchBannedPlayers();
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function deleteBannedPlayer(uid: string): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const currentG = activeGuild();
    const res = await deleteBannedPlayerRow(client, uid, currentG);
    if (res.error) throw res.error;
    removeBannedPlayer(uid);
    showToast(t('toast_player_unbanned_ok'), 'success');
    await fetchBannedPlayers();
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

let bannedUiWired = false;

/** Wires the static Banned-tab controls app.js owned (form + search). */
export function initBannedUi(): void {
  if (bannedUiWired) return;
  bannedUiWired = true;

  const form = byId<HTMLFormElement>('add-banned-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void handleAddBannedPlayer();
    });
  }

  const search = byId<HTMLInputElement>('banned-search');
  if (search) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    search.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => renderBannedPlayers(), 200);
    });
  }
}
