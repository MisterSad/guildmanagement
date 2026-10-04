/**
 * src/modules/app/members/members.controller.ts
 *
 * Sous-lot 6.6 (Strangler) — member CRUD, pending transfers, UID-taken dialog,
 * transfer request and edit-member dialog ported from app.js. Strict escaping
 * on pseudos/UIDs/notes; confirmations via showConfirm; toasts via the
 * dialogs service.
 */

import { styleRef } from '../../../core/dom/style-refs';
import { adoptDialog } from '../../../components/ui/Dialog';
import { eventsViewLazy, armsRaceViewLazy, shadowfrontViewLazy } from '../lazy-views';
import { t, esc, byId } from '../admin/utils';
import { getActiveGuild } from '../../../core/auth/roles';
import { patchAppState } from '../../../core/state/app-state';
import {
  getGuildMembers,
  setGuildMembers,
  pushGuildMember,
  filterGuildMembersOut,
  getPendingTransfers,
  setPendingTransfers,
  transferActionFor,
} from './members.store';
import { renderGuildMembers, membersSkeletonHtml } from './members.render';
import { showToast, showConfirm } from '../dialogs/dialogs.service';
import { getClient } from '../../../core/api/supabase';
import { cache } from '../../../core/cache/cache';
import { avatarInit, formatPower, validatePseudo, validateUid } from '../../../core/utils/text';
import { getUidStatus } from '../../ocr/ocr.service';
import {
  addMember,
  updateMember,
  listGuildMembers,
  listPendingTransfers,
  listPlayerAbsences,
  fetchLatestGloryScores,
  resolveGuildTransfer,
  requestGuildTransfer,
  checkUidExistsGlobally,
  findPlayerByUid,
  findBannedUid,
  deleteGuildMemberRow,
  listTransferEligibleGuilds,
  fetchGuildServerNumber,
  transferGuildMember,
  listNameHistory,
  deleteNameHistoryEntry,
} from '../../members/members.service';
import { toastFetchError, isAbortError } from '../../../core/api/fetch-errors';
import { COMMON_TIMEZONES, detectUserTimezone, getTimezoneOffset } from '../../../utils/timezone';

function db(): any {
  return getClient();
}
/**
 * H2: one resolver, shared. This used to re-implement the restriction →
 * current → localStorage → ALPHA chain locally -- one of four independent
 * copies, each free to disagree with the others.
 */
function activeGuild(): string | null {
  return getActiveGuild();
}
/*
 * PHASE 7. `maybeInitOcr()` lived here and probed `GM_OCR.initGeminiModule`.
 * That method does not exist and never has -- the bridge exposes
 * `initOcrGeminiModule`. The call therefore never fired once, from the day it
 * was written, and nothing reported it: probing `window` for a name that is not
 * there is indistinguishable from choosing not to call it.
 *
 * Nothing broke because the initialisation is lazy anyway: `openOcrModal()`
 * calls `initOcrGeminiModule()` itself, guarded by `ocrModuleInitialized`. The
 * dead pre-warm is removed rather than repaired -- wiring it back would add DOM
 * setup to every Members load, which is a behaviour change nobody asked for.
 */

function gmDebounce(fn: () => void, wait: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn();
    }, wait);
  };
}

let membersUiWired = false;

/**
 * Wires the static Members-tab controls that app.js owned (add-member form,
 * optional military-scores toggle, roster search/tier/sort filters). Idempotent.
 */
export function initMembersUi(): void {
  if (membersUiWired) return;
  membersUiWired = true;
  const addMemberForm = byId<HTMLFormElement>('add-member-form');
  if (addMemberForm) {
    addMemberForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void handleAddMember('member-pseudo', 'member-uid', 'member-power', 'member-role');
    });
  }

  const toggleMilitaryBtn = byId<HTMLButtonElement>('toggle-add-member-military');
  const militaryFields = byId('add-member-military-fields');
  if (toggleMilitaryBtn && militaryFields) {
    toggleMilitaryBtn.addEventListener('click', () => {
      const isHidden = militaryFields.style.display === 'none';
      militaryFields.style.display = isHidden ? 'grid' : 'none';
      const span = toggleMilitaryBtn.querySelector('span');
      if (span) {
        span.textContent = isHidden
          ? '- Hide Optional Military Scores'
          : '+ Optional Military Scores (Fleet, Tech, Flagship, Champions, Crew, Glory)';
      }
    });
  }

  const debouncedSearch = gmDebounce(() => renderGuildMembers(true), 200);
  const searchAdmin = byId<HTMLInputElement>('member-search-admin');
  if (searchAdmin) searchAdmin.addEventListener('input', debouncedSearch);
  const tierAdminSelect = byId<HTMLSelectElement>('member-tier-filter-admin');
  if (tierAdminSelect) tierAdminSelect.addEventListener('change', () => renderGuildMembers(true));
  const sortAdminSelect = byId<HTMLSelectElement>('member-sort-admin');
  if (sortAdminSelect) sortAdminSelect.addEventListener('change', () => renderGuildMembers(true));
}

// ── Fetch ────────────────────────────────────────────────────────────────────

function applySignal(builder: any, signal?: AbortSignal): any {
  if (!signal || !builder || typeof builder.abortSignal !== 'function') return builder;
  try {
    return builder.abortSignal(signal);
  } catch {
    return builder;
  }
}

/**
 * Loads the roster batch (4 queries in parallel). Accepts an optional
 * AbortSignal from the tab router so switching tabs cancels the batch
 * (P3-03); shows a cold-start skeleton only when nothing is cached yet
 * (P3-08), and surfaces failures through the unified error mapper (P3-01).
 */
export async function fetchGuildMembers(opts?: { signal?: AbortSignal }): Promise<void> {
  const client = db();
  if (!client) return;
  const currentG = activeGuild();
  const signal = opts && opts.signal ? opts.signal : undefined;

  if (getGuildMembers().length === 0) {
    const list = byId('guild-member-list');
    if (list) list.innerHTML = membersSkeletonHtml();
  }

  try {
    const [res, transfersRes, absencesRes, gloryRes] = await Promise.all([
      applySignal(listGuildMembers(client, currentG), signal),
      applySignal(listPendingTransfers(client), signal),
      applySignal(listPlayerAbsences(client, currentG), signal),
      // One row per player, newest first: the full history crossed 1,000 rows
      // for one guild and lost its oldest scores (audit PERF-05).
      applySignal(fetchLatestGloryScores(client, currentG), signal),
    ]);

    if (res.error) throw res.error;

    const latestGloryMap: Record<string, number> = {};
    if (gloryRes && !gloryRes.error && Array.isArray(gloryRes.data)) {
      gloryRes.data.forEach((r: any) => {
        if (r && r.pseudo && r.score != null) {
          const pKey = String(r.pseudo).trim().toLowerCase();
          if (latestGloryMap[pKey] === undefined) latestGloryMap[pKey] = parseInt(r.score, 10) || 0;
        }
      });
    }

    setGuildMembers(
      (res.data || []).map((m: any) => {
        const pKey = String(m.pseudo || '')
          .trim()
          .toLowerCase();
        const lastGlory = latestGloryMap[pKey];
        if (lastGlory !== undefined && lastGlory > 0) {
          if (!m.glory_score || parseInt(m.glory_score, 10) === 0 || parseInt(m.glory_score, 10) !== lastGlory)
            m.glory_score = lastGlory;
        }
        return m;
      })
    );

    if (!transfersRes.error) {
      setPendingTransfers(
        (transfersRes.data || []).filter((tr: any) => tr.target_guild === currentG || tr.source_guild === currentG)
      );
    }

    patchAppState({ guildAbsences: !absencesRes.error ? absencesRes.data || [] : [] });

    renderPendingTransfers();
    renderGuildMembers();
  } catch (err: any) {
    if (isAbortError(err)) return;
    toastFetchError(err, t('toast_err_fetch_members') || 'members', () => {
      void fetchGuildMembers();
    });
  }
}

// ── Pending transfers ────────────────────────────────────────────────────────

const TRANSFER_ERROR_MESSAGES: Record<string, string> = {
  permission_denied: 'You do not have permission to resolve this transfer.',
  transfer_not_found_or_resolved: 'This transfer was already resolved or no longer exists.',
  member_no_longer_in_source: 'This player has already left their original guild — the transfer is no longer valid.',
  uid_already_in_target: 'A member with this UID already exists in your guild.',
  duplicate_pseudo_in_target: 'A member with this name already exists in your guild.',
  invalid_action: 'Unrecognized action.',
};

export function renderPendingTransfers(): void {
  const section = byId('admin-pending-transfers-section');
  const list = byId('admin-pending-transfers-list');
  const count = byId('admin-pending-transfers-count') || byId('pending-transfers-count');
  if (!section || !list || !count) return;

  const transfers = getPendingTransfers();
  // `hidden` rather than style.display (M5: index.html carries no inline styles).
  section.classList.toggle('hidden', transfers.length === 0);
  if (transfers.length === 0) return;

  count.textContent = String(transfers.length);
  const currentG = activeGuild();

  let html = '';
  transfers.forEach((tr) => {
    const isIncoming = tr.target_guild === currentG;
    const mode = transferActionFor(tr, currentG);
    const approverGuild = tr.requested_by === 'admin' ? tr.source_guild : tr.target_guild;
    const directionBadge = isIncoming
      ? '<span class="u-fs-fs-xs gm-chip gm-chip-success"><i class="ph ph-arrow-down-left"></i> IN</span>'
      : '<span class="u-fs-fs-xs u-bg-rgba-251-191-36-0_12 u-c-hexfbbf24 u-border-1px-solid-rgba-251-52ad40 gm-chip"><i class="ph ph-arrow-up-right"></i> OUT</span>';
    const actions =
      mode === 'decide'
        ? '<button type="button" class="u-mr-0_25rem gm-btn gm-btn-sm gm-btn-success" data-transfer-action="approve" data-transfer-dir="' +
          (isIncoming ? 'in' : 'out') +
          '" data-transfer-id="' +
          esc(tr.id) +
          '" title="Approve Transfer"><i class="ph ph-check"></i></button>' +
          '<button type="button" class="gm-btn gm-btn-sm gm-btn-danger" data-transfer-action="reject" data-transfer-dir="' +
          (isIncoming ? 'in' : 'out') +
          '" data-transfer-id="' +
          esc(tr.id) +
          '" title="Reject Transfer"><i class="ph ph-x"></i></button>'
        : mode === 'withdraw'
          ? '<span class="u-fs-fs-xs u-c-text-dim u-mr-0_35rem"><i class="ph ph-hourglass"></i> Awaiting approval from ' +
            esc(approverGuild) +
            '</span>' +
            '<button type="button" class="gm-btn gm-btn-sm gm-btn-ghost" data-transfer-action="reject" data-transfer-dir="withdraw" data-transfer-id="' +
            esc(tr.id) +
            '" title="Withdraw your request"><i class="ph ph-x"></i></button>'
          : '<span class="u-fs-fs-xs u-c-text-dim"><i class="ph ph-hourglass"></i> Awaiting approval from ' +
            esc(approverGuild) +
            '</span>';

    html +=
      '<tr>' +
      '<td data-label="Player"><div class="gm-member-name"><div class="gm-avatar gm-avatar-sm gm-avatar-info">' +
      esc(avatarInit(tr.pseudo)) +
      '</div>' +
      esc(tr.pseudo) +
      '</div></td>' +
      '<td data-label="UID"><div class="gm-uid-badge">' +
      esc(tr.uid) +
      '</div></td>' +
      '<td data-label="Direction">' +
      directionBadge +
      '</td>' +
      '<td data-label="From">' +
      esc(tr.source_guild) +
      ' &rarr; ' +
      esc(tr.target_guild) +
      '</td>' +
      '<td class="u-ws-nowrap gm-center" data-label="Actions">' +
      actions +
      '</td>' +
      '</tr>';
  });
  list.innerHTML = html;
  list.querySelectorAll('[data-transfer-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void resolveTransfer(
        btn.getAttribute('data-transfer-id') || '',
        btn.getAttribute('data-transfer-action') || '',
        btn.getAttribute('data-transfer-dir') || 'in'
      );
    });
  });
}

export async function resolveTransfer(transferId: string, action: string, dir: string = 'in'): Promise<void> {
  const client = db();
  if (!client) return;
  const title = dir === 'withdraw' ? 'Withdraw Request' : action === 'approve' ? 'Approve Transfer' : 'Reject Transfer';
  const message =
    dir === 'withdraw'
      ? 'Withdraw your transfer request?'
      : action === 'approve'
        ? dir === 'out'
          ? 'Another guild asked to take this player. Approve, and the player leaves your guild with their history?'
          : 'Approve this transfer and add the player to your guild?'
        : 'Reject this transfer request?';
  showConfirm(title, message, async () => {
    try {
      const { data, error } = await resolveGuildTransfer(client, transferId, action);
      if (error || !data || !data.ok) {
        const errCode = data && data.error ? data.error : null;
        const errStr = (errCode && TRANSFER_ERROR_MESSAGES[errCode]) || (error ? error.message : 'Unknown error.');
        showToast('Failed to ' + action + ' transfer: ' + errStr, 'error');
        void fetchGuildMembers();
      } else {
        showToast('Transfer ' + action + 'd successfully.', 'success');
        void fetchGuildMembers();
        cache.invalidate();
      }
    } catch (err: any) {
      if (isAbortError(err)) return;
      toastFetchError(err, 'transfer');
    }
  });
}

// ── UID already taken ────────────────────────────────────────────────────────

export async function showUidTakenDialog(typedPseudo: string, uid: string, info: any, extraData?: any): Promise<void> {
  const existing = byId('uid-taken-overlay');
  if (existing) existing.remove();

  const p = info.player || {};
  const server = p.server_number ? 'Server #' + p.server_number : 'Server unknown';
  const currentG = activeGuild();
  const members = getGuildMembers();

  const isSameGuild = Boolean(
    (p.guild && currentG && String(p.guild).trim().toUpperCase() === String(currentG).trim().toUpperCase()) ||
      members.some((m) => m.uid && String(m.uid).trim() === String(uid).trim())
  );

  const history = info.name_history || [];
  const historyHtml =
    history.length > 0
      ? '<div class="u-mt-0_75rem u-bt-1px-solid-border-soft u-pt-0_65rem">' +
        '<div class="u-fs-fs-xs u-fw-700 u-tracking-0_05em u-tt-uppercase u-c-text-muted u-mb-0_35rem">Name history</div>' +
        '<div class="u-d-flex u-dir-column u-gap-0_2rem">' +
        history
          .slice(0, 5)
          .map(
            (h: any) =>
              '<div class="u-fs-fs-sm u-c-text-dim">' +
              '<span class="u-c-text-muted u-td-line-through">' +
              esc(h.old_pseudo) +
              '</span>' +
              ' &rarr; <span class="u-c-accent u-fw-600">' +
              esc(h.new_pseudo) +
              '</span>' +
              '<span class="u-ml-0_5rem u-fs-fs-xs">(' +
              esc(String(h.changed_at || '').slice(0, 10)) +
              ')</span>' +
              '</div>'
          )
          .join('') +
        '</div>' +
        '</div>'
      : '';

  const overlay = document.createElement('div');
  overlay.id = 'uid-taken-overlay';
  overlay.className = 'gm-modal-overlay';

  let titleHtml = '';
  let bodyHtml = '';
  let noticeHtml = '';
  let footerHtml = '';

  const detailRow = (label: string, value: string, strong = false): string =>
    '<div class="u-d-flex u-justify-space-between u-gap-1rem u-wrap-wrap"><span class="u-c-text-muted">' +
    esc(label) +
    '</span>' +
    (strong ? '<strong class="u-c-fg">' + esc(value) + '</strong>' : '<span>' + esc(value) + '</span>') +
    '</div>';

  if (isSameGuild) {
    const localExisting = members.find((m) => m.uid && String(m.uid).trim() === String(uid).trim());
    const existingPseudo = p.pseudo || (localExisting ? localExisting.pseudo : 'Existing Player');
    const displayPower =
      extraData && !isNaN(extraData.power)
        ? extraData.power
        : p.overall_power || (localExisting ? localExisting.overall_power : 0);
    const displayRole = (extraData && extraData.role) || p.role || (localExisting ? localExisting.role : 'R1');

    titleHtml =
      '<div class="u-d-flex u-items-center u-gap-0_5rem"><i class="u-fs-fs-3xl u-c-accent ph ph-user-switch"></i><h3 class="u-m-0 u-fs-fs-xl">Player Already in Guild</h3></div>';
    bodyHtml =
      '<div class="u-bg-rgba-255-255-255-0_03 u-border-1px-solid-border-soft u-rounded-8px u-p-0_9rem u-d-flex u-dir-column u-gap-0_4rem">' +
      detailRow('Current Name', existingPseudo, true) +
      detailRow('New Name', typedPseudo, true) +
      detailRow('Player ID', uid) +
      detailRow('Guild', p.guild || currentG, true) +
      detailRow('Server', server) +
      detailRow('Rank', displayRole) +
      detailRow('Power', formatPower(displayPower)) +
      historyHtml +
      '</div>';
    noticeHtml =
      '<div class="u-bg-info-soft u-c-info u-p-0_75rem u-rounded-6px u-fs-fs-sm u-lh-1_45 u-mt-0_85rem">' +
      '<i class="u-mr-4px ph ph-info"></i>This player (<strong>' +
      esc(existingPseudo) +
      '</strong>) already belongs to <strong>' +
      esc(p.guild || currentG) +
      '</strong>. Would you like to update their name to <strong>' +
      esc(typedPseudo) +
      '</strong>?' +
      '</div>';
    footerHtml =
      '<div class="u-d-flex u-justify-flex-end u-gap-0_5rem u-mt-1_4rem gm-modal-footer">' +
      '<button type="button" class="gm-btn gm-btn-ghost gm-close-uid">Cancel</button>' +
      '<button type="button" id="uid-rename-btn" class="gm-btn gm-btn-primary"><i class="ph ph-pencil-simple"></i> <span>Update Player Name</span></button>' +
      '</div>';
  } else {
    titleHtml =
      '<div class="u-d-flex u-items-center u-gap-0_5rem"><i class="u-fs-fs-3xl u-c-accent ph ph-user-circle-gear"></i><h3 class="u-m-0 u-fs-fs-xl">Player ID already exists</h3></div>';
    bodyHtml =
      '<div class="u-bg-rgba-255-255-255-0_03 u-border-1px-solid-border-soft u-rounded-8px u-p-0_9rem u-d-flex u-dir-column u-gap-0_4rem">' +
      detailRow('Player', p.pseudo || typedPseudo, true) +
      detailRow('Player ID', uid) +
      detailRow('Current Guild', p.guild || '?', true) +
      detailRow('Server', server) +
      (p.role ? detailRow('Rank', p.role) : '') +
      historyHtml +
      '</div>';
    noticeHtml =
      '<div class="u-bg-info-soft u-c-info u-p-0_75rem u-rounded-6px u-fs-fs-sm u-lh-1_45 u-mt-0_85rem">' +
      '<i class="u-mr-4px ph ph-info"></i>This player already belongs to <strong>' +
      esc(p.guild || 'another guild') +
      '</strong>. You cannot add them directly here. You can send a transfer request so an admin approves moving them to <strong>' +
      esc(currentG) +
      '</strong>.' +
      '</div>' +
      '<label class="u-d-flex u-items-flex-start u-gap-0_5rem u-mt-0_85rem u-cursor-pointer u-fs-fs-sm u-c-text-muted">' +
      '<input type="checkbox" id="uid-taken-confirm" class="u-mt-2px u-accent-accent">' +
      "<span>I understand this process cannot be undone without reporting an issue or bug, and that the transfer must be approved by the player's current guild.</span>" +
      '</label>';
    footerHtml =
      '<div class="u-d-flex u-justify-flex-end u-gap-0_5rem u-mt-1_4rem gm-modal-footer">' +
      '<button type="button" class="gm-btn gm-btn-ghost gm-close-uid">Cancel</button>' +
      '<button type="button" id="uid-taken-request-btn" class="gm-btn gm-btn-primary" disabled><i class="ph ph-arrows-left-right"></i> <span>Request Transfer</span></button>' +
      '</div>';
  }

  overlay.innerHTML =
    '<div class="u-maxw-520px u-w-92pct u-pos-relative u-text-left gm-modal-card">' +
    '<div class="u-d-flex u-items-center u-justify-space-between u-mb-1rem gm-modal-header">' +
    titleHtml +
    '<button type="button" class="u-cursor-pointer gm-mini-btn gm-close-uid" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button>' +
    '</div>' +
    bodyHtml +
    noticeHtml +
    footerHtml +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const closeDialog = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => {
      overlay.remove();
    }, 200);
  };
  adoptDialog(overlay, { onEscape: closeDialog });
  overlay.querySelectorAll('.gm-close-uid').forEach((btn) => btn.addEventListener('click', closeDialog));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeDialog();
  });

  if (isSameGuild) {
    const renameBtn = byId<HTMLButtonElement>('uid-rename-btn');
    if (renameBtn) {
      renameBtn.addEventListener('click', async () => {
        renameBtn.disabled = true;
        const span = renameBtn.querySelector('span');
        if (span) span.textContent = 'Updating...';
        const localExisting = members.find((m) => m.uid && String(m.uid).trim() === String(uid).trim());
        const existingPseudo = p.pseudo || (localExisting ? localExisting.pseudo : typedPseudo);
        const newPower =
          extraData && !isNaN(extraData.power)
            ? extraData.power
            : p.overall_power || (localExisting ? localExisting.overall_power : 0);
        const newRole = (extraData && extraData.role) || p.role || (localExisting ? localExisting.role : 'R1');
        const extraMetrics = extraData
          ? {
              fleet_rating: extraData.fleet_rating,
              tech_power: extraData.tech_power,
              flagship_power: extraData.flagship_power,
              champion_power: extraData.champion_power,
              crew_power: extraData.crew_power,
              glory_score: extraData.glory_score,
            }
          : {};
        try {
          const ok = await renameGuildMember(existingPseudo, typedPseudo, uid, newPower, newRole, extraMetrics);
          if (ok) closeDialog();
          else {
            renameBtn.disabled = false;
            if (span) span.textContent = 'Update Player Name';
          }
        } catch (err: any) {
          showToast('Failed to update player name: ' + err.message, 'error');
          renameBtn.disabled = false;
          if (span) span.textContent = 'Update Player Name';
        }
      });
    }
  } else {
    const confirmCb = byId<HTMLInputElement>('uid-taken-confirm');
    const requestBtn = byId<HTMLButtonElement>('uid-taken-request-btn');
    if (confirmCb && requestBtn)
      confirmCb.addEventListener('change', () => {
        requestBtn.disabled = !confirmCb.checked;
      });
    if (requestBtn) {
      requestBtn.addEventListener('click', async () => {
        requestBtn.disabled = true;
        const span = requestBtn.querySelector('span');
        if (span) span.textContent = 'Requesting...';
        try {
          const client = db();
          const { data, error } = await requestGuildTransfer(client, uid, currentG);
          if (error) throw error;
          if (!data || !data.ok) throw new Error((data && data.error) || 'request_failed');
          closeDialog();
          showToast(
            "Transfer request sent. The player's current guild must approve it: it appears in their Pending Transfers.",
            'success'
          );
          void fetchGuildMembers();
        } catch (err: any) {
          showToast('Could not request transfer: ' + err.message, 'error');
          requestBtn.disabled = false;
          if (span) span.textContent = 'Request Transfer';
        }
      });
    }
  }
}

// ── Add member ───────────────────────────────────────────────────────────────

export async function handleAddMember(
  inputId: string,
  uidInputId: string,
  powerInputId: string,
  roleInputId: string
): Promise<void> {
  const client = db();
  if (!client) return;
  const input = byId<HTMLInputElement>(inputId);
  const pseudo = input ? input.value.trim() : '';
  const uidInput = byId<HTMLInputElement>(uidInputId);
  const uidVal = uidInput ? uidInput.value.trim() : '';
  const powerInput = powerInputId ? byId<HTMLInputElement>(powerInputId) : null;
  const powerVal = powerInput && powerInput.value ? parseInt(powerInput.value, 10) : NaN;
  const roleInput = roleInputId ? byId<HTMLSelectElement>(roleInputId) : null;
  const roleVal = roleInput ? roleInput.value : 'R1';

  if (!pseudo || !uidVal || isNaN(powerVal) || powerVal < 0) {
    showToast('Please enter a valid power value.', 'error');
    return;
  }
  const pseudoErr = validatePseudo(pseudo);
  if (pseudoErr) {
    showToast(t(pseudoErr), 'error');
    return;
  }
  const uidErr = validateUid(uidVal);
  if (uidErr) {
    showToast(t(uidErr), 'error');
    return;
  }

  const members = getGuildMembers();
  if (members.some((m) => String(m.pseudo).toLowerCase() === pseudo.toLowerCase())) {
    showToast(t('toast_duplicate_member'), 'error');
    return;
  }

  const readInt = (id: string): number => {
    const el = byId<HTMLInputElement>(id);
    return el ? parseInt(el.value, 10) || 0 : 0;
  };
  const fleetVal = readInt('member-fleet');
  const techVal = readInt('member-tech');
  const flagshipVal = readInt('member-flagship');
  const champVal = readInt('member-champ');
  const crewVal = readInt('member-crew');
  const gloryVal = readInt('member-glory');

  const extraData = {
    power: powerVal,
    role: roleVal,
    fleet_rating: fleetVal,
    tech_power: techVal,
    flagship_power: flagshipVal,
    champion_power: champVal,
    crew_power: crewVal,
    glory_score: gloryVal,
  };

  try {
    const uidCheck = await checkUidExistsGlobally(client, uidVal);
    if (uidCheck.error) throw uidCheck.error;
    if (uidCheck.data) {
      const lookup = await findPlayerByUid(client, uidVal);
      if (lookup.error) throw lookup.error;
      const info = lookup.data || {};
      if (!info.ok) throw new Error(info.error || 'lookup_failed');
      if (info.found || info.player) {
        await showUidTakenDialog(pseudo, uidVal, info, extraData);
        return;
      }
      showToast('Player ID is already in use. Use Transfer instead.', 'error');
      return;
    }
  } catch (err) {
    console.error('Global UID check failed', err);
    const localExisting = members.find((m) => m.uid && String(m.uid).trim() === String(uidVal).trim());
    if (localExisting) {
      await showUidTakenDialog(
        pseudo,
        uidVal,
        {
          ok: true,
          found: true,
          player: {
            pseudo: localExisting.pseudo,
            uid: localExisting.uid,
            guild: activeGuild(),
            role: localExisting.role,
            overall_power: localExisting.overall_power,
          },
          name_history: [],
        },
        extraData
      );
      return;
    }
  }

  try {
    const banCheck = await findBannedUid(client, uidVal);
    if (banCheck.error) throw banCheck.error;
    if (banCheck.data && banCheck.data.length > 0) {
      showToast(t('toast_cannot_add_banned_player'), 'error');
      return;
    }
  } catch (err) {
    console.error('Ban check failed', err);
  }

  try {
    // The row, its first metrics snapshot and its enrolment in the running
    // events are one transaction (M4a); the row pushed is the one stored.
    const added = await addMember({
      pseudo,
      uid: uidVal,
      overall_power: powerVal,
      role: roleVal,
      fleet_rating: fleetVal,
      tech_power: techVal,
      flagship_power: flagshipVal,
      champion_power: champVal,
      crew_power: crewVal,
      glory_score: gloryVal,
    });
    pushGuildMember(added.member);

    [
      'member-pseudo',
      'member-uid',
      'member-power',
      'member-fleet',
      'member-tech',
      'member-flagship',
      'member-champ',
      'member-crew',
      'member-glory',
    ].forEach((id) => {
      const el = byId<HTMLInputElement>(id);
      if (el) el.value = '';
    });
    if (roleInput) roleInput.value = 'R1';

    renderGuildMembers();
    showToast(pseudo + ' ' + t('toast_member_added'), 'success');
    cache.invalidate();

    const addedEvents = added.added_events || 0;

    // Phase 7: direct calls. These were three `window` probes that no-opped
    // whenever a name drifted -- the same shape as the dead `maybeInitOcr`
    // above, which probed a method that never existed.
    // Only views already open have anything to bring in step (M5: lazy views).
    await eventsViewLazy.peek()?.addMemberToActiveEvents(pseudo);
    await armsRaceViewLazy.peek()?.addMemberToActiveEvents(pseudo);
    await shadowfrontViewLazy.peek()?.load();

    if (addedEvents > 0) showToast(pseudo + ' ' + t('toast_member_added_active_events'), 'info');
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

const R5_DELETE_MESSAGE = 'The R5 leader cannot be removed. Change their role first (Edit), then remove them.';

export async function deleteGuildMember(pseudo: string): Promise<void> {
  const client = db();
  if (!client) return;
  const target = getGuildMembers().find((m) => m.pseudo === pseudo);
  if (target && target.role === 'R5') {
    showToast(R5_DELETE_MESSAGE, 'warning');
    return;
  }
  try {
    const currentG = activeGuild();
    const res = await deleteGuildMemberRow(client, pseudo, currentG);
    if (res.error) throw res.error;
    filterGuildMembersOut((m) => m.pseudo === pseudo);
    renderGuildMembers();
    showToast(t('toast_member_removed'), 'success');
    cache.invalidate();

    eventsViewLazy.peek()?.removeMemberFromActiveEvents(pseudo);
    armsRaceViewLazy.peek()?.removeMemberFromActiveEvents(pseudo);
    await shadowfrontViewLazy.peek()?.load();
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

// ── Rename / update member ───────────────────────────────────────────────────

export async function renameGuildMember(
  oldPseudo: string,
  newPseudoInput: string,
  newUidInput: string,
  newPower: unknown,
  newRole: string,
  extraMetrics?: any
): Promise<boolean> {
  const client = db();
  if (!client) return false;
  const newPseudo = (newPseudoInput || '').trim();
  const newUid = (newUidInput || '').trim();
  const powerVal = parseInt(String(newPower), 10) || 0;
  const roleVal = newRole || 'R1';
  extraMetrics = extraMetrics || {};

  const pseudoErr = validatePseudo(newPseudo);
  if (pseudoErr) {
    showToast(t(pseudoErr), 'error');
    return false;
  }
  const uidErr = validateUid(newUid);
  if (uidErr) {
    showToast(t(uidErr), 'error');
    return false;
  }

  const members = getGuildMembers();
  const member = members.find(
    (m) =>
      (m.pseudo && String(m.pseudo).toLowerCase() === oldPseudo.toLowerCase()) ||
      (m.uid && newUid && String(m.uid).trim() === String(newUid).trim())
  );

  const oldPower = member ? parseInt(String(member.overall_power), 10) || 0 : 0;
  const oldRole = member ? member.role || 'R1' : 'R1';
  const pseudoChanged = newPseudo.toLowerCase() !== oldPseudo.toLowerCase();
  const uidChanged = !!member && (member.uid || '') !== newUid;
  const powerChanged = oldPower !== powerVal;
  const roleChanged = oldRole !== roleVal;
  const metricsChanged =
    extraMetrics.tech_power !== undefined ||
    extraMetrics.champion_power !== undefined ||
    extraMetrics.crew_power !== undefined ||
    extraMetrics.flagship_power !== undefined ||
    extraMetrics.fleet_rating !== undefined ||
    extraMetrics.glory_score !== undefined;
  const tzChanged =
    extraMetrics.timezone !== undefined &&
    (member ? (member.timezone || null) !== (extraMetrics.timezone || null) : true);
  const offsetChanged =
    extraMetrics.timezone_offset !== undefined &&
    (member ? member.timezone_offset !== extraMetrics.timezone_offset : true);

  if (!pseudoChanged && !uidChanged && !powerChanged && !roleChanged && !metricsChanged && !tzChanged && !offsetChanged)
    return true;

  if (
    pseudoChanged &&
    members.some(
      (m) => String(m.pseudo).toLowerCase() === newPseudo.toLowerCase() && (member ? m.pseudo !== member.pseudo : true)
    )
  ) {
    showToast(t('toast_duplicate_member'), 'error');
    return false;
  }
  if (uidChanged && newUid && members.some((m) => m.pseudo !== oldPseudo && (m.uid || '') === newUid)) {
    showToast(t('toast_duplicate_uid'), 'error');
    return false;
  }
  if (uidChanged && newUid) {
    try {
      const banCheck = await findBannedUid(client, newUid);
      if (banCheck.error) throw banCheck.error;
      if (banCheck.data && banCheck.data.length > 0) {
        showToast(t('toast_cannot_rename_banned_player'), 'error');
        return false;
      }
    } catch (err) {
      console.error('Ban check failed', err);
    }
  }

  try {
    const targetPseudo = member ? member.pseudo : oldPseudo;

    const update: any = {};
    if (pseudoChanged) update.pseudo = newPseudo;
    if (uidChanged) update.uid = newUid || null;
    update.overall_power = powerVal;
    update.role = roleVal;
    if (extraMetrics.tech_power !== undefined) update.tech_power = parseInt(extraMetrics.tech_power, 10) || 0;
    if (extraMetrics.champion_power !== undefined)
      update.champion_power = parseInt(extraMetrics.champion_power, 10) || 0;
    if (extraMetrics.crew_power !== undefined) update.crew_power = parseInt(extraMetrics.crew_power, 10) || 0;
    if (extraMetrics.flagship_power !== undefined)
      update.flagship_power = parseInt(extraMetrics.flagship_power, 10) || 0;
    if (extraMetrics.fleet_rating !== undefined) update.fleet_rating = parseInt(extraMetrics.fleet_rating, 10) || 0;
    if (extraMetrics.glory_score !== undefined) update.glory_score = parseInt(extraMetrics.glory_score, 10) || 0;
    if (extraMetrics.timezone !== undefined) update.timezone = extraMetrics.timezone || null;
    if (extraMetrics.timezone_offset !== undefined) update.timezone_offset = extraMetrics.timezone_offset;

    // One transaction (M4a): the update, the metrics snapshot, this week's
    // Glory entry when Glory changed, and the name-history row of a rename
    // (written by the server, with the caller's account as its author). The
    // history row used to be written first and kept when the rename failed.
    await updateMember(targetPseudo, update);

    await fetchGuildMembers();
    showToast(t('toast_member_updated'), 'success');
    cache.invalidate();
    return true;
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
    return false;
  }
}

// ── Transfer dialog ──────────────────────────────────────────────────────────

export async function showTransferMemberDialog(member: any): Promise<void> {
  const client = db();
  if (!client) return;
  const existing = byId('transfer-member-overlay');
  if (existing) existing.remove();

  const currentG = activeGuild();
  const eligPromise = listTransferEligibleGuilds(client, currentG);
  const curPromise = fetchGuildServerNumber(client, currentG);

  let eligibleGuilds: any[] = [];
  try {
    const eligRes = await eligPromise;
    if (eligRes.error) throw eligRes.error;
    eligibleGuilds = eligRes.data || [];
  } catch (err) {
    console.error('Failed to fetch transfer-eligible guilds', err);
  }

  if (eligibleGuilds.length === 0) {
    showToast(
      'No other guild is eligible for transfer right now. Set a server number in Super Admin > Guilds & Server Numbers, or ask a super admin to open a cross-server migration window.',
      'warning'
    );
    return;
  }

  let currentServer: any = null;
  try {
    const curRes = await curPromise;
    currentServer = curRes.data ? curRes.data.server_number : null;
  } catch (err) {
    console.warn('Failed to fetch current guild server number', err);
  }

  const optionsHtml = eligibleGuilds
    .map((gg) => {
      const label = gg.is_same_server
        ? gg.id + ' (Server #' + gg.server_number + ')'
        : gg.id + ' (Server #' + gg.server_number + ' — Migration Window)';
      return (
        '<option value="' + esc(gg.id) + '" data-server="' + esc(gg.server_number) + '">' + esc(label) + '</option>'
      );
    })
    .join('');

  const html =
    '<div id="transfer-member-overlay" class="gm-modal-overlay">' +
    '<div class="u-maxw-480px u-w-90pct u-pos-relative gm-modal-card">' +
    '<div class="u-d-flex u-items-center u-justify-space-between u-mb-1rem gm-modal-header">' +
    '<div class="u-d-flex u-items-center u-gap-0_5rem"><i class="u-fs-fs-3xl u-c-accent ph ph-arrows-left-right"></i><h3 class="u-m-0 u-fs-fs-xl">Transfer Member</h3></div>' +
    '<button type="button" class="gm-mini-btn gm-close-modal" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button>' +
    '</div>' +
    '<div class="u-d-flex u-dir-column u-gap-1rem gm-modal-body">' +
    '<div class="u-bg-rgba-255-255-255-0_03 u-p-0_75rem u-rounded-6px u-border-1px-solid-rgba-255-fbc4d8">' +
    '<div><strong>Player:</strong> <span class="u-c-accent u-fw-700">' +
    esc(member.pseudo) +
    '</span> (UID: ' +
    esc(member.uid) +
    ')</div>' +
    '<div class="u-fs-fs-base u-c-text-dim u-mt-0_25rem">Current Guild: <strong>' +
    esc(currentG) +
    '</strong> (Server #' +
    esc(currentServer) +
    ')</div>' +
    '</div>' +
    '<div class="gm-form-group">' +
    '<label class="u-fs-fs-base u-fw-600 u-mb-0_35rem u-d-block gm-label" for="transfer-target-guild">Select Target Guild:</label>' +
    '<select id="transfer-target-guild" class="gm-select gm-input">' +
    optionsHtml +
    '</select>' +
    '</div>' +
    '</div>' +
    '<div class="u-d-flex u-justify-flex-end u-gap-0_5rem u-mt-1_5rem gm-modal-footer">' +
    '<button type="button" class="gm-btn gm-btn-ghost gm-close-modal">Cancel</button>' +
    '<button type="button" id="confirm-transfer-btn" class="gm-btn gm-btn-primary"><i class="ph ph-arrows-left-right"></i><span>Confirm Transfer</span></button>' +
    '</div>' +
    '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = byId('transfer-member-overlay');
  if (!overlay) return;
  requestAnimationFrame(() => overlay.classList.add('visible'));
  const closeModal = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => {
      overlay.remove();
    }, 200);
  };
  overlay.querySelectorAll('.gm-close-modal').forEach((btn) => btn.addEventListener('click', closeModal));
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeModal();
  });
  adoptDialog(overlay, { onEscape: closeModal });

  const confirmBtn = byId<HTMLButtonElement>('confirm-transfer-btn');
  if (!confirmBtn) return;
  confirmBtn.addEventListener('click', async () => {
    const targetSelect = byId<HTMLSelectElement>('transfer-target-guild');
    const targetGuild = targetSelect ? targetSelect.value : null;
    if (!targetGuild) return;
    confirmBtn.disabled = true;
    const span = confirmBtn.querySelector('span');
    if (span) span.textContent = 'Transferring...';
    try {
      // Phase 3: the canonical name. `transfer_guild_member` was a one-line
      // SQL wrapper around exactly this, with the identical signature.
      const res = await transferGuildMember(client, member.uid, targetGuild, member.pseudo);
      if (res.error) throw res.error;
      if (!res.data || !res.data.ok) throw new Error((res.data && res.data.error) || 'transfer_failed');
      const targetOption = targetSelect!.options[targetSelect!.selectedIndex];
      const targetServer = targetOption ? targetOption.getAttribute('data-server') : currentServer;
      closeModal();
      showToast(member.pseudo + ' transferred to ' + targetGuild + ' on Server #' + targetServer + '!', 'success');
      cache.invalidate();
      await fetchGuildMembers();
    } catch (err: any) {
      showToast('Error transferring member: ' + err.message, 'error');
      confirmBtn.disabled = false;
      if (span) span.textContent = 'Confirm Transfer';
    }
  });
}

// ── Edit dialog ──────────────────────────────────────────────────────────────

export async function showEditMemberDialog(member: any): Promise<void> {
  const client = db();
  if (!client) return;
  const existing = byId('edit-member-overlay');
  if (existing) existing.remove();

  let nameHistory: any[] = [];
  if (member.uid) {
    try {
      const res = await listNameHistory(client, member.uid);
      if (!res.error) nameHistory = res.data || [];
    } catch (err) {
      console.error('Fetch name history failed', err);
    }
  }

  const overlay = document.createElement('div');
  overlay.id = 'edit-member-overlay';
  overlay.className = 'gm-modal-overlay';

  const historyHtml =
    nameHistory.length > 0
      ? '<div class="u-mt-1rem u-bt-1px-solid-border-soft u-pt-1rem u-text-left">' +
        '<h4 class="u-m-0-0-0_5rem-0 u-fs-fs-md u-c-text-muted"><i class="ph ph-clock-counter-clockwise"></i> ' +
        t('Name History') +
        '</h4>' +
        '<div class="u-maxh-120px u-oy-auto u-d-flex u-dir-column u-gap-0_35rem">' +
        nameHistory
          .map((h) => {
            const date = new Date(h.changed_at).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            });
            return (
              '<div class="u-d-flex u-justify-space-between u-items-center u-fs-fs-sm u-bg-bg-dim u-border-1px-solid-border-soft u-p-0_35rem-0_5rem u-rounded-radius-sm">' +
              '<span><strong>' +
              esc(h.old_pseudo) +
              '</strong> ➔ <strong>' +
              esc(h.new_pseudo) +
              '</strong> <span class="u-fs-fs-sm gm-dim">(' +
              date +
              ' by ' +
              esc(h.changed_by) +
              ')</span></span>' +
              '<button type="button" class="u-bg-none u-border-none u-c-error u-cursor-pointer u-p-2px delete-history-btn" data-id="' +
              esc(h.id) +
              '" aria-label="Delete this name change"><i class="ph ph-trash" aria-hidden="true"></i></button>' +
              '</div>'
            );
          })
          .join('') +
        '</div></div>'
      : '';

  const uidStat = getUidStatus(member.uid);
  const isTempUid = !uidStat.valid;
  const uidHelperHtml = isTempUid
    ? '<div id="edit-uid-helper" class="u-fs-fs-sm u-c-hexf87171 u-mt-0_35rem u-d-flex u-items-center u-gap-0_25rem"><i class="ph ph-warning"></i> ' +
      esc(uidStat.label || '') +
      ' (' +
      esc(uidStat.reason || 'Enter real 6-10 digit game UID') +
      ')</div>'
    : '';

  const metricInput = (id: string, label: string, value: unknown, placeholder: string): string =>
    '<div class="input-group"><label for="' +
    id +
    '" class="u-fs-fs-sm">' +
    label +
    '</label>' +
    '<input type="number" id="' +
    id +
    '" class="u-p-0_35rem-0_5rem u-fs-fs-sm gm-input" value="' +
    esc(value || '') +
    '" placeholder="' +
    placeholder +
    '"></div>';

  const memberTz = member.timezone || '';
  const tzRegions = Array.from(new Set(COMMON_TIMEZONES.map((z) => z.region)));
  const tzOptionsHtml =
    '<option value="">-- No timezone set --</option>' +
    tzRegions
      .map((region) => {
        const zones = COMMON_TIMEZONES.filter((z) => z.region === region);
        return (
          '<optgroup label="' +
          esc(region) +
          '">' +
          zones
            .map(
              (z) =>
                '<option value="' +
                esc(z.zone) +
                '"' +
                (memberTz === z.zone ? ' selected' : '') +
                '>' +
                esc(z.label) +
                '</option>'
            )
            .join('') +
          '</optgroup>'
        );
      })
      .join('') +
    (memberTz && !COMMON_TIMEZONES.some((z) => z.zone === memberTz)
      ? '<optgroup label="Custom"><option value="' +
        esc(memberTz) +
        '" selected>' +
        esc(memberTz) +
        '</option></optgroup>'
      : '');

  overlay.innerHTML =
    '<div class="u-maxw-480px u-w-95vw gm-modal-card">' +
    '<div class="confirm-icon"><i class="ph ph-pencil-simple text-accent"></i></div>' +
    '<h3>' +
    t('edit_member_title') +
    '</h3>' +
    '<p>' +
    t('edit_member_body') +
    '</p>' +
    '<form id="edit-member-form" class="u-d-flex u-dir-column u-gap-1rem u-mt-1rem">' +
    '<div class="input-group"><label for="edit-pseudo">' +
    t('label_pseudo') +
    '</label><div class="input-wrapper"><i class="ph ph-game-controller"></i>' +
    '<input type="text" id="edit-pseudo" required value="' +
    esc(member.pseudo) +
    '"></div></div>' +
    '<div class="input-group"><label for="edit-uid">UID</label><div class="input-wrapper"><i class="ph ph-identification-badge"></i>' +
    '<input type="text" id="edit-uid" value="' +
    esc(member.uid || '') +
    '" placeholder="e.g. 1917131" ' +
    (isTempUid ? 'data-gm-style="' + styleRef('border-color:rgba(239,68,68,0.7);') + '"' : '') +
    '></div>' +
    uidHelperHtml +
    '</div>' +
    '<div class="u-d-flex u-gap-1rem">' +
    '<div class="u-flex-1 input-group"><label for="edit-power">Overall Power</label><div class="input-wrapper"><i class="ph ph-sword"></i>' +
    '<input type="number" id="edit-power" value="' +
    esc(member.overall_power || '') +
    '" placeholder="e.g. 80000000"></div></div>' +
    '<div class="u-flex-1 input-group"><label for="edit-role"><i class="ph ph-crown"></i> Role</label>' +
    '<select id="edit-role" class="u-bg-bg-1 u-border-1px-solid-border-soft u-c-text-normal u-w-100pct u-rounded-radius-md u-p-0_65rem-0_75rem">' +
    ['R1', 'R2', 'R3', 'R4', 'R5']
      .map((r) => '<option value="' + r + '"' + (member.role === r ? ' selected' : '') + '>' + r + '</option>')
      .join('') +
    '</select></div>' +
    '</div>' +
    '<div class="input-group">' +
    '<div class="u-d-flex u-justify-space-between u-items-center u-mb-0_25rem">' +
    '<label for="edit-timezone" class="u-fs-fs-sm"><i class="ph ph-clock"></i> Timezone</label>' +
    '<button type="button" id="edit-detect-tz-btn" class="u-p-0_15rem-0_4rem u-fs-fs-xs u-d-inline-flex u-items-center u-gap-0_25rem gm-btn gm-btn-ghost" title="Detect browser timezone">' +
    '<i class="ph ph-crosshair"></i> Auto-detect' +
    '</button>' +
    '</div>' +
    '<div class="input-wrapper"><i class="ph ph-globe"></i>' +
    '<select id="edit-timezone" class="u-bg-bg-1 u-border-1px-solid-border-soft u-c-text-normal u-w-100pct u-rounded-radius-md u-p-0_65rem-0_75rem">' +
    tzOptionsHtml +
    '</select></div>' +
    '</div>' +
    '<div class="u-bg-bg-dim u-border-1px-solid-border-soft u-rounded-radius-md u-p-0_75rem u-d-flex u-dir-column u-gap-0_5rem">' +
    '<div class="u-fs-fs-sm u-fw-700 u-c-accent"><i class="ph ph-crosshair"></i> Tactical Military Scores</div>' +
    '<div class="u-d-grid u-cols-repeat-auto-fit-mi-12e1ba u-gap-0_5rem">' +
    metricInput('edit-fleet', '⚔️ Fleet Rating', member.fleet_rating, 'e.g. 2000000') +
    metricInput('edit-tech', '🔬 Tech Power', member.tech_power, 'e.g. 15000000') +
    metricInput('edit-flagship', '🚀 Flagship Power', member.flagship_power, 'e.g. 10000000') +
    metricInput('edit-champ', '👑 Champions Power', member.champion_power, 'e.g. 30000000') +
    metricInput('edit-crew', '👥 Crew Power', member.crew_power, 'e.g. 5000000') +
    metricInput('edit-glory', '🏆 Glory Score', member.glory_score, 'e.g. 50000000') +
    '</div>' +
    '</div>' +
    historyHtml +
    '<div class="confirm-actions">' +
    '<button type="button" id="edit-cancel" class="gm-btn gm-btn-ghost">' +
    t('confirm_cancel') +
    '</button>' +
    '<button type="submit" class="gm-btn gm-btn-primary">' +
    t('confirm_ok') +
    '</button>' +
    '</div>' +
    '</form>' +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const close = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => {
      overlay.remove();
    }, 300);
  };
  const cancelBtn = byId('edit-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });
  adoptDialog(overlay, { onEscape: close });

  const editUidInput = byId<HTMLInputElement>('edit-uid');
  if (editUidInput) {
    editUidInput.addEventListener('input', () => {
      const st = getUidStatus(editUidInput.value.trim());
      const helper = byId('edit-uid-helper');
      if (!st.valid) {
        editUidInput.style.borderColor = 'rgba(239,68,68,0.7)';
        if (helper) {
          helper.style.display = 'flex';
          helper.innerHTML =
            '<i class="ph ph-warning"></i> ' +
            esc(st.label || '') +
            ' (' +
            esc(st.reason || 'Enter real 6-10 digit game UID') +
            ')';
        }
      } else {
        editUidInput.style.borderColor = 'rgba(52,211,153,0.7)';
        if (helper) helper.style.display = 'none';
      }
    });
  }

  const detectTzBtn = byId<HTMLButtonElement>('edit-detect-tz-btn');
  const editTzSelect = byId<HTMLSelectElement>('edit-timezone');
  if (detectTzBtn && editTzSelect) {
    detectTzBtn.addEventListener('click', () => {
      const detected = detectUserTimezone();
      let exists = false;
      for (let i = 0; i < editTzSelect.options.length; i++) {
        if (editTzSelect.options[i].value === detected) {
          editTzSelect.selectedIndex = i;
          exists = true;
          break;
        }
      }
      if (!exists && detected) {
        const opt = document.createElement('option');
        opt.value = detected;
        opt.textContent = detected + ' (Detected)';
        opt.selected = true;
        editTzSelect.appendChild(opt);
      }
      showToast('Detected timezone: ' + detected, 'info');
    });
  }

  overlay.querySelectorAll('.delete-history-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id') || '';
      const res = await deleteNameHistoryEntry(client, id);
      if (!res.error) {
        (btn as HTMLElement).closest('div')?.remove();
        showToast('History entry removed', 'success');
      } else showToast('Error removing history entry', 'error');
    });
  });

  const form = byId<HTMLFormElement>('edit-member-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = (id: string): string => {
        const el = byId<HTMLInputElement | HTMLSelectElement>(id);
        return el ? el.value : '';
      };
      const tzVal = val('edit-timezone').trim();
      const tzOffset = tzVal
        ? getTimezoneOffset(tzVal)
        : member.timezone_offset != null
          ? member.timezone_offset
          : null;
      const extraMetrics = {
        fleet_rating: parseInt(val('edit-fleet'), 10) || 0,
        tech_power: parseInt(val('edit-tech'), 10) || 0,
        flagship_power: parseInt(val('edit-flagship'), 10) || 0,
        champion_power: parseInt(val('edit-champ'), 10) || 0,
        crew_power: parseInt(val('edit-crew'), 10) || 0,
        glory_score: parseInt(val('edit-glory'), 10) || 0,
        timezone: tzVal || null,
        timezone_offset: tzOffset,
      };
      const ok = await renameGuildMember(
        member.pseudo,
        val('edit-pseudo'),
        val('edit-uid'),
        val('edit-power'),
        val('edit-role'),
        extraMetrics
      );
      if (ok) close();
    });
  }
}
