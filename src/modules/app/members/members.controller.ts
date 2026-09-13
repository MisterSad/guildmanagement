/**
 * src/modules/app/members/members.controller.ts
 *
 * Sous-lot 6.6 (Strangler) — member CRUD, pending transfers, UID-taken dialog,
 * transfer request and edit-member dialog ported from app.js. Strict escaping
 * on pseudos/UIDs/notes; confirmations via window.showConfirm; toasts via the
 * dialogs service.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { t, esc, winAny, byId } from '../admin/utils';
import { patchAppState } from '../state/app-state';
import { getGuildMembers, setGuildMembers, pushGuildMember, filterGuildMembersOut, findGuildMember, getPendingTransfers, setPendingTransfers } from './members.store';
import { renderGuildMembers } from './members.render';
import { showToast } from '../dialogs/dialogs.service';

function g(): any {
  return winAny().GM;
}
function w(): any {
  return winAny();
}
function db(): any {
  const x = g();
  return x && x.db ? x.db : null;
}
function activeGuild(): string {
  const x = winAny();
  const gm = g();
  if (gm && typeof gm.getActiveGuild === 'function') return gm.getActiveGuild();
  return x.currentGuildRestriction || x.currentGuild || localStorage.getItem('gm_current_guild') || 'ALPHA';
}
function avatarInit(value: unknown): string {
  const x = g();
  return x && typeof x.avatarInit === 'function' ? x.avatarInit(value) : String(value || '?').charAt(0).toUpperCase();
}
function maybeInitOcr(): void {
  const ocr = winAny().GM_OCR;
  if (ocr && typeof ocr.initGeminiModule === 'function') ocr.initGeminiModule();
}

function gmDebounce(fn: () => void, wait: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { fn(); }, wait);
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

export async function fetchGuildMembers(): Promise<void> {
  const client = db();
  if (!client) return;
  maybeInitOcr();
  const currentG = activeGuild();

  try {
    const [res, transfersRes, absencesRes, gloryRes] = await Promise.all([
      client.from('guild_members').select('*').eq('guild', currentG).order('pseudo', { ascending: true }),
      client.from('guild_transfers').select('id, uid, pseudo, source_guild, target_guild').eq('status', 'pending').order('created_at', { ascending: true }),
      client.from('player_absences').select('*').eq('guild', currentG),
      client.from('event_participants').select('pseudo, score, week_start').eq('guild', currentG).eq('event_name', 'Glory').not('score', 'is', null).order('week_start', { ascending: false })
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

    setGuildMembers((res.data || []).map((m: any) => {
      const pKey = String(m.pseudo || '').trim().toLowerCase();
      const lastGlory = latestGloryMap[pKey];
      if (lastGlory !== undefined && lastGlory > 0) {
        if (!m.glory_score || parseInt(m.glory_score) === 0 || parseInt(m.glory_score) !== lastGlory) m.glory_score = lastGlory;
      }
      return m;
    }));

    if (!transfersRes.error) {
      setPendingTransfers((transfersRes.data || []).filter((tr: any) => tr.target_guild === currentG || tr.source_guild === currentG));
    }

    patchAppState({ guildAbsences: (!absencesRes.error ? (absencesRes.data || []) : []) });

    renderPendingTransfers();
    renderGuildMembers();
  } catch (err: any) {
    showToast(t('toast_err_fetch_members') + ' ' + err.message, 'error');
  }
}

// ── Pending transfers ────────────────────────────────────────────────────────

const TRANSFER_ERROR_MESSAGES: Record<string, string> = {
  permission_denied: 'You do not have permission to resolve this transfer.',
  transfer_not_found_or_resolved: 'This transfer was already resolved or no longer exists.',
  subscription_expired: "Your guild's subscription is not active.",
  member_no_longer_in_source: 'This player has already left their original guild — the transfer is no longer valid.',
  uid_already_in_target: 'A member with this UID already exists in your guild.',
  duplicate_pseudo_in_target: 'A member with this name already exists in your guild.',
  invalid_action: 'Unrecognized action.'
};

export function renderPendingTransfers(): void {
  const section = byId('admin-pending-transfers-section');
  const list = byId('admin-pending-transfers-list');
  const count = byId('admin-pending-transfers-count') || byId('pending-transfers-count');
  if (!section || !list || !count) return;

  const transfers = getPendingTransfers();
  if (transfers.length === 0) { section.style.display = 'none'; return; }

  section.style.display = '';
  count.textContent = String(transfers.length);
  const currentG = activeGuild();

  let html = '';
  transfers.forEach((tr) => {
    const isIncoming = tr.target_guild === currentG;
    const directionBadge = isIncoming
      ? '<span class="gm-chip gm-chip-success" style="font-size: var(--fs-xs);"><i class="ph ph-arrow-down-left"></i> IN</span>'
      : '<span class="gm-chip" style="font-size: var(--fs-xs); background:rgba(251,191,36,0.12); color:#fbbf24; border:1px solid rgba(251,191,36,0.3);"><i class="ph ph-arrow-up-right"></i> OUT</span>';
    const actions = isIncoming
      ? '<button type="button" class="gm-btn gm-btn-sm gm-btn-success" data-transfer-action="approve" data-transfer-id="' + esc(tr.id) + '" style="margin-right: 0.25rem;" title="Approve Transfer"><i class="ph ph-check"></i></button>' +
        '<button type="button" class="gm-btn gm-btn-sm gm-btn-danger" data-transfer-action="reject" data-transfer-id="' + esc(tr.id) + '" title="Reject Transfer"><i class="ph ph-x"></i></button>'
      : '<span style="font-size: var(--fs-xs); color:var(--text-dim);"><i class="ph ph-hourglass"></i> Awaiting approval from ' + esc(tr.target_guild) + '</span>';

    html += '<tr>' +
      '<td data-label="Player"><div class="gm-member-name"><div class="gm-avatar gm-avatar-sm gm-avatar-info">' + esc(avatarInit(tr.pseudo)) + '</div>' + esc(tr.pseudo) + '</div></td>' +
      '<td data-label="UID"><div class="gm-uid-badge">' + esc(tr.uid) + '</div></td>' +
      '<td data-label="Direction">' + directionBadge + '</td>' +
      '<td data-label="From">' + esc(tr.source_guild) + ' &rarr; ' + esc(tr.target_guild) + '</td>' +
      '<td class="gm-center" data-label="Actions" style="white-space: nowrap;">' + actions + '</td>' +
    '</tr>';
  });
  list.innerHTML = html;
  list.querySelectorAll('[data-transfer-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void resolveTransfer(btn.getAttribute('data-transfer-id') || '', btn.getAttribute('data-transfer-action') || '');
    });
  });
}

export async function resolveTransfer(transferId: string, action: string): Promise<void> {
  const client = db();
  if (!client) return;
  const title = action === 'approve' ? 'Approve Transfer' : 'Reject Transfer';
  const message = action === 'approve' ? 'Approve this transfer and add the player to your guild?' : 'Reject this transfer request?';
  const confirm = winAny().showConfirm;
  if (!confirm) return;

  confirm(title, message, async () => {
    try {
      const { data, error } = await client.rpc('resolve_guild_transfer', { p_transfer_id: transferId, p_action: action });
      if (error || !data || !data.ok) {
        const errCode = data && data.error ? data.error : null;
        const errStr = (errCode && TRANSFER_ERROR_MESSAGES[errCode]) || (error ? error.message : 'Unknown error.');
        showToast('Failed to ' + action + ' transfer: ' + errStr, 'error');
        void fetchGuildMembers();
      } else {
        showToast('Transfer ' + action + 'd successfully.', 'success');
        void fetchGuildMembers();
        if (g() && g().cache && typeof g().cache.invalidate === 'function') g().cache.invalidate();
      }
    } catch (err) {
      console.error(err);
      showToast('Error processing transfer.', 'error');
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
  const historyHtml = history.length > 0
    ? '<div style="margin-top:0.75rem; border-top:1px solid var(--border-soft); padding-top:0.65rem;">' +
        '<div style="font-size: var(--fs-xs); font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--text-muted); margin-bottom:0.35rem;">Name history</div>' +
        '<div style="display:flex; flex-direction:column; gap:0.2rem;">' +
          history.slice(0, 5).map((h: any) =>
            '<div style="font-size: var(--fs-sm); color:var(--text-dim);">' +
              '<span style="color:var(--text-muted); text-decoration:line-through;">' + esc(h.old_pseudo) + '</span>' +
              ' &rarr; <span style="color:var(--accent); font-weight:600;">' + esc(h.new_pseudo) + '</span>' +
              '<span style="margin-left:0.5rem; font-size: var(--fs-xs);">(' + esc(String(h.changed_at || '').slice(0, 10)) + ')</span>' +
            '</div>').join('') +
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
    '<div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;"><span style="color:var(--text-muted);">' + esc(label) + '</span>' +
    (strong ? '<strong style="color:var(--fg);">' + esc(value) + '</strong>' : '<span>' + esc(value) + '</span>') + '</div>';

  if (isSameGuild) {
    const localExisting = members.find((m) => m.uid && String(m.uid).trim() === String(uid).trim());
    const existingPseudo = p.pseudo || (localExisting ? localExisting.pseudo : 'Existing Player');
    const displayPower = extraData && !isNaN(extraData.power) ? extraData.power : (p.overall_power || (localExisting ? localExisting.overall_power : 0));
    const displayRole = (extraData && extraData.role) || p.role || (localExisting ? localExisting.role : 'R1');

    titleHtml = '<div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph ph-user-switch" style="font-size: var(--fs-3xl); color:var(--accent);"></i><h3 style="margin:0; font-size: var(--fs-xl);">Player Already in Guild</h3></div>';
    bodyHtml = '<div style="background: rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:8px; padding:0.9rem; display:flex; flex-direction:column; gap:0.4rem;">' +
      detailRow('Current Name', existingPseudo, true) + detailRow('New Name', typedPseudo, true) +
      detailRow('Player ID', uid) + detailRow('Guild', p.guild || currentG, true) +
      detailRow('Server', server) + detailRow('Rank', displayRole) +
      detailRow('Power', g() && g().formatPower ? g().formatPower(displayPower) : String(displayPower)) + historyHtml +
    '</div>';
    noticeHtml = '<div style="background: var(--info-soft); color: var(--info); padding:0.75rem; border-radius:6px; font-size: var(--fs-sm); line-height:1.45; margin-top:0.85rem;">' +
      '<i class="ph ph-info" style="margin-right:4px;"></i>This player (<strong>' + esc(existingPseudo) + '</strong>) already belongs to <strong>' + esc(p.guild || currentG) + '</strong>. Would you like to update their name to <strong>' + esc(typedPseudo) + '</strong>?' +
    '</div>';
    footerHtml = '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1.4rem;">' +
      '<button type="button" class="gm-btn gm-btn-ghost gm-close-uid">Cancel</button>' +
      '<button type="button" id="uid-rename-btn" class="gm-btn gm-btn-primary"><i class="ph ph-pencil-simple"></i> <span>Update Player Name</span></button>' +
    '</div>';
  } else {
    titleHtml = '<div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph ph-user-circle-gear" style="font-size: var(--fs-3xl); color:var(--accent);"></i><h3 style="margin:0; font-size: var(--fs-xl);">Player ID already exists</h3></div>';
    bodyHtml = '<div style="background: rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:8px; padding:0.9rem; display:flex; flex-direction:column; gap:0.4rem;">' +
      detailRow('Player', p.pseudo || typedPseudo, true) + detailRow('Player ID', uid) +
      detailRow('Current Guild', p.guild || '?', true) + detailRow('Server', server) +
      (p.role ? detailRow('Rank', p.role) : '') + historyHtml +
    '</div>';
    noticeHtml = '<div style="background: var(--info-soft); color: var(--info); padding:0.75rem; border-radius:6px; font-size: var(--fs-sm); line-height:1.45; margin-top:0.85rem;">' +
      '<i class="ph ph-info" style="margin-right:4px;"></i>This player already belongs to <strong>' + esc(p.guild || 'another guild') + '</strong>. You cannot add them directly here. You can send a transfer request so an admin approves moving them to <strong>' + esc(currentG) + '</strong>.' +
    '</div>' +
    '<label style="display:flex; align-items:flex-start; gap:0.5rem; margin-top:0.85rem; cursor:pointer; font-size: var(--fs-sm); color:var(--text-muted);">' +
      '<input type="checkbox" id="uid-taken-confirm" style="margin-top:2px; accent-color: var(--accent);">' +
      '<span>I understand this process cannot be undone without reporting an issue or bug, and that the transfer must be approved by an admin.</span>' +
    '</label>';
    footerHtml = '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1.4rem;">' +
      '<button type="button" class="gm-btn gm-btn-ghost gm-close-uid">Cancel</button>' +
      '<button type="button" id="uid-taken-request-btn" class="gm-btn gm-btn-primary" disabled><i class="ph ph-arrows-left-right"></i> <span>Request Transfer</span></button>' +
    '</div>';
  }

  overlay.innerHTML =
    '<div class="gm-modal-card" style="max-width: 520px; width: 92%; position: relative; text-align:left;">' +
      '<div class="gm-modal-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:1rem;">' +
        titleHtml + '<button type="button" class="gm-mini-btn gm-close-uid" style="cursor:pointer;"><i class="ph ph-x"></i></button>' +
      '</div>' + bodyHtml + noticeHtml + footerHtml +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const closeDialog = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 200);
  };
  overlay.querySelectorAll('.gm-close-uid').forEach((btn) => btn.addEventListener('click', closeDialog));
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeDialog(); });

  if (isSameGuild) {
    const renameBtn = byId<HTMLButtonElement>('uid-rename-btn');
    if (renameBtn) {
      renameBtn.addEventListener('click', async () => {
        renameBtn.disabled = true;
        const span = renameBtn.querySelector('span');
        if (span) span.textContent = 'Updating...';
        const localExisting = members.find((m) => m.uid && String(m.uid).trim() === String(uid).trim());
        const existingPseudo = p.pseudo || (localExisting ? localExisting.pseudo : typedPseudo);
        const newPower = extraData && !isNaN(extraData.power) ? extraData.power : (p.overall_power || (localExisting ? localExisting.overall_power : 0));
        const newRole = (extraData && extraData.role) || p.role || (localExisting ? localExisting.role : 'R1');
        const extraMetrics = extraData ? {
          fleet_rating: extraData.fleet_rating, tech_power: extraData.tech_power, flagship_power: extraData.flagship_power,
          champion_power: extraData.champion_power, crew_power: extraData.crew_power, glory_score: extraData.glory_score
        } : {};
        try {
          const ok = await renameGuildMember(existingPseudo, typedPseudo, uid, newPower, newRole, extraMetrics);
          if (ok) closeDialog();
          else { renameBtn.disabled = false; if (span) span.textContent = 'Update Player Name'; }
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
    if (confirmCb && requestBtn) confirmCb.addEventListener('change', () => { requestBtn.disabled = !confirmCb.checked; });
    if (requestBtn) {
      requestBtn.addEventListener('click', async () => {
        requestBtn.disabled = true;
        const span = requestBtn.querySelector('span');
        if (span) span.textContent = 'Requesting...';
        try {
          const client = db();
          const { data, error } = await client.rpc('gm_admin_request_transfer', { p_uid: uid, p_target_guild: currentG });
          if (error) throw error;
          if (!data || !data.ok) throw new Error((data && data.error) || 'request_failed');
          closeDialog();
          showToast('Transfer request sent to ' + currentG + '. It will appear in the pending list for approval.', 'success');
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

export async function handleAddMember(inputId: string, uidInputId: string, powerInputId: string, roleInputId: string): Promise<void> {
  const client = db();
  if (!client) return;
  const gm = g();
  const input = byId<HTMLInputElement>(inputId);
  const pseudo = input ? input.value.trim() : '';
  const uidInput = byId<HTMLInputElement>(uidInputId);
  const uidVal = uidInput ? uidInput.value.trim() : '';
  const powerInput = powerInputId ? byId<HTMLInputElement>(powerInputId) : null;
  const powerVal = powerInput && powerInput.value ? parseInt(powerInput.value, 10) : NaN;
  const roleInput = roleInputId ? byId<HTMLSelectElement>(roleInputId) : null;
  const roleVal = roleInput ? roleInput.value : 'R1';

  if (!pseudo || !uidVal || isNaN(powerVal) || powerVal < 0) { showToast('Please enter a valid power value.', 'error'); return; }
  const pseudoErr = gm && typeof gm.validatePseudo === 'function' ? gm.validatePseudo(pseudo) : '';
  if (pseudoErr) { showToast(t(pseudoErr), 'error'); return; }
  const uidErr = gm && typeof gm.validateUid === 'function' ? gm.validateUid(uidVal) : '';
  if (uidErr) { showToast(t(uidErr), 'error'); return; }

  const members = getGuildMembers();
  if (members.some((m) => String(m.pseudo).toLowerCase() === pseudo.toLowerCase())) { showToast(t('toast_duplicate_member'), 'error'); return; }

  const readInt = (id: string): number => { const el = byId<HTMLInputElement>(id); return el ? (parseInt(el.value) || 0) : 0; };
  const fleetVal = readInt('member-fleet');
  const techVal = readInt('member-tech');
  const flagshipVal = readInt('member-flagship');
  const champVal = readInt('member-champ');
  const crewVal = readInt('member-crew');
  const gloryVal = readInt('member-glory');

  const extraData = {
    power: powerVal, role: roleVal, fleet_rating: fleetVal, tech_power: techVal, flagship_power: flagshipVal,
    champion_power: champVal, crew_power: crewVal, glory_score: gloryVal
  };

  try {
    const uidCheck = await client.rpc('check_uid_exists_globally', { p_uid: uidVal });
    if (uidCheck.error) throw uidCheck.error;
    if (uidCheck.data) {
      const lookup = await client.rpc('gm_find_player_by_uid', { p_uid: uidVal });
      if (lookup.error) throw lookup.error;
      const info = lookup.data || {};
      if (!info.ok) throw new Error(info.error || 'lookup_failed');
      if (info.found || info.player) { await showUidTakenDialog(pseudo, uidVal, info, extraData); return; }
      showToast('Player ID is already in use. Use Transfer instead.', 'error');
      return;
    }
  } catch (err) {
    console.error('Global UID check failed', err);
    const localExisting = members.find((m) => m.uid && String(m.uid).trim() === String(uidVal).trim());
    if (localExisting) {
      await showUidTakenDialog(pseudo, uidVal, {
        ok: true, found: true,
        player: { pseudo: localExisting.pseudo, uid: localExisting.uid, guild: activeGuild(), role: localExisting.role, overall_power: localExisting.overall_power },
        name_history: []
      }, extraData);
      return;
    }
  }

  try {
    const banCheck = await client.from('banned_players').select('uid').eq('uid', uidVal);
    if (banCheck.error) throw banCheck.error;
    if (banCheck.data && banCheck.data.length > 0) { showToast(t('toast_cannot_add_banned_player'), 'error'); return; }
  } catch (err) { console.error('Ban check failed', err); }

  try {
    const currentG = activeGuild();
    const newMemberRow: any = {
      pseudo, uid: uidVal, overall_power: powerVal, role: roleVal, guild: currentG,
      fleet_rating: fleetVal, tech_power: techVal, flagship_power: flagshipVal,
      champion_power: champVal, crew_power: crewVal, glory_score: gloryVal
    };
    const insertRes = await client.from('guild_members').insert([newMemberRow]);
    if (insertRes.error) throw insertRes.error;
    newMemberRow.created_at = new Date().toISOString();
    pushGuildMember(newMemberRow);

    ['member-pseudo', 'member-uid', 'member-power', 'member-fleet', 'member-tech', 'member-flagship', 'member-champ', 'member-crew', 'member-glory']
      .forEach((id) => { const el = byId<HTMLInputElement>(id); if (el) el.value = ''; });
    if (roleInput) roleInput.value = 'R1';

    if (fleetVal || techVal || flagshipVal || champVal || crewVal || gloryVal || powerVal) {
      try {
        await client.rpc('gm_upsert_player_metrics', {
          p_guild: currentG, p_pseudo: pseudo, p_total_power: powerVal, p_tech_power: techVal,
          p_champion_power: champVal, p_crew_power: crewVal, p_flagship_power: flagshipVal,
          p_fleet_rating: fleetVal, p_glory_score: gloryVal
        });
      } catch (e) { console.error('Initial player metrics snapshot error:', e); }
    }

    renderGuildMembers();
    showToast(pseudo + ' ' + t('toast_member_added'), 'success');
    if (gm && gm.cache && typeof gm.cache.invalidate === 'function') gm.cache.invalidate();

    let addedEvents = 0;
    try {
      const enrollRes = await client.rpc('gm_add_member_to_active_events', { p_pseudo: pseudo, p_guild: activeGuild() });
      if (!enrollRes.error && typeof enrollRes.data === 'number') addedEvents = enrollRes.data;
    } catch (err) { console.error('Auto-enroll into active events failed', err); }

    const events = winAny().GM_EVENTS;
    if (events && typeof events.addMemberToActiveEvents === 'function') await events.addMemberToActiveEvents(pseudo);
    const armsrace = winAny().GM_ARMSRACE;
    if (armsrace && typeof armsrace.addMemberToActiveEvents === 'function') await armsrace.addMemberToActiveEvents(pseudo);
    const shadowfront = winAny().GM_SHADOWFRONT;
    if (shadowfront && typeof shadowfront.load === 'function') await shadowfront.load();

    if (addedEvents > 0) showToast(pseudo + ' ' + t('toast_member_added_active_events'), 'info');
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

export async function deleteGuildMember(pseudo: string): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const currentG = activeGuild();
    const res = await client.from('guild_members').delete().eq('pseudo', pseudo).eq('guild', currentG);
    if (res.error) throw res.error;
    filterGuildMembersOut((m) => m.pseudo === pseudo);
    renderGuildMembers();
    showToast(t('toast_member_removed'), 'success');
    const gm = g();
    if (gm && gm.cache && typeof gm.cache.invalidate === 'function') gm.cache.invalidate();

    const events = winAny().GM_EVENTS;
    if (events && typeof events.removeMemberFromActiveEvents === 'function') events.removeMemberFromActiveEvents(pseudo);
    const armsrace = winAny().GM_ARMSRACE;
    if (armsrace && typeof armsrace.removeMemberFromActiveEvents === 'function') armsrace.removeMemberFromActiveEvents(pseudo);
    const shadowfront = winAny().GM_SHADOWFRONT;
    if (shadowfront && typeof shadowfront.load === 'function') await shadowfront.load();
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

// ── Rename / update member ───────────────────────────────────────────────────

export async function renameGuildMember(
  oldPseudo: string, newPseudoInput: string, newUidInput: string, newPower: unknown, newRole: string, extraMetrics?: any
): Promise<boolean> {
  const client = db();
  if (!client) return false;
  const gm = g();
  const newPseudo = (newPseudoInput || '').trim();
  const newUid = (newUidInput || '').trim();
  const powerVal = parseInt(String(newPower)) || 0;
  const roleVal = newRole || 'R1';
  extraMetrics = extraMetrics || {};

  const pseudoErr = gm && typeof gm.validatePseudo === 'function' ? gm.validatePseudo(newPseudo) : '';
  if (pseudoErr) { showToast(t(pseudoErr), 'error'); return false; }
  const uidErr = gm && typeof gm.validateUid === 'function' ? gm.validateUid(newUid) : '';
  if (uidErr) { showToast(t(uidErr), 'error'); return false; }

  const members = getGuildMembers();
  const member = members.find((m) =>
    (m.pseudo && String(m.pseudo).toLowerCase() === oldPseudo.toLowerCase()) ||
    (m.uid && newUid && String(m.uid).trim() === String(newUid).trim()));

  const oldPower = member ? parseInt(String(member.overall_power)) || 0 : 0;
  const oldRole = member ? member.role || 'R1' : 'R1';
  const pseudoChanged = newPseudo.toLowerCase() !== oldPseudo.toLowerCase();
  const uidChanged = !!member && (member.uid || '') !== newUid;
  const powerChanged = oldPower !== powerVal;
  const roleChanged = oldRole !== roleVal;
  const metricsChanged = extraMetrics.tech_power !== undefined || extraMetrics.champion_power !== undefined ||
    extraMetrics.crew_power !== undefined || extraMetrics.flagship_power !== undefined ||
    extraMetrics.fleet_rating !== undefined || extraMetrics.glory_score !== undefined;

  if (!pseudoChanged && !uidChanged && !powerChanged && !roleChanged && !metricsChanged) return true;

  if (pseudoChanged && members.some((m) => String(m.pseudo).toLowerCase() === newPseudo.toLowerCase() && (member ? m.pseudo !== member.pseudo : true))) {
    showToast(t('toast_duplicate_member'), 'error'); return false;
  }
  if (uidChanged && newUid && members.some((m) => m.pseudo !== oldPseudo && (m.uid || '') === newUid)) {
    showToast(t('toast_duplicate_uid'), 'error'); return false;
  }
  if (uidChanged && newUid) {
    try {
      const banCheck = await client.from('banned_players').select('uid').eq('uid', newUid);
      if (banCheck.error) throw banCheck.error;
      if (banCheck.data && banCheck.data.length > 0) { showToast(t('toast_cannot_rename_banned_player'), 'error'); return false; }
    } catch (err) { console.error('Ban check failed', err); }
  }

  try {
    const activeG = activeGuild();
    const targetPseudo = member ? member.pseudo : oldPseudo;

    if (pseudoChanged && (newUid || (member && member.uid))) {
      const histIns = await client.from('player_name_history').insert({
        guild: activeG, uid: newUid || (member ? member.uid : null),
        old_pseudo: oldPseudo, new_pseudo: newPseudo,
        changed_by: gm.currentAccountId || localStorage.getItem('gm_user') || 'Admin'
      });
      if (histIns.error) console.error('Logging name history failed', histIns.error);
    }

    const update: any = {};
    if (pseudoChanged) update.pseudo = newPseudo;
    if (uidChanged) update.uid = newUid || null;
    update.overall_power = powerVal;
    update.role = roleVal;
    if (extraMetrics.tech_power !== undefined) update.tech_power = parseInt(extraMetrics.tech_power) || 0;
    if (extraMetrics.champion_power !== undefined) update.champion_power = parseInt(extraMetrics.champion_power) || 0;
    if (extraMetrics.crew_power !== undefined) update.crew_power = parseInt(extraMetrics.crew_power) || 0;
    if (extraMetrics.flagship_power !== undefined) update.flagship_power = parseInt(extraMetrics.flagship_power) || 0;
    if (extraMetrics.fleet_rating !== undefined) update.fleet_rating = parseInt(extraMetrics.fleet_rating) || 0;
    if (extraMetrics.glory_score !== undefined) update.glory_score = parseInt(extraMetrics.glory_score) || 0;
    update.power_updated_at = new Date().toISOString();
    update.metrics_updated_at = new Date().toISOString();

    const res = await client.from('guild_members').update(update).eq('guild', activeG).eq('pseudo', targetPseudo);
    if (res.error) throw res.error;

    try {
      await client.rpc('gm_upsert_player_metrics', {
        p_guild: activeG, p_pseudo: newPseudo, p_total_power: powerVal,
        p_tech_power: update.tech_power !== undefined ? update.tech_power : (member ? member.tech_power : 0),
        p_champion_power: update.champion_power !== undefined ? update.champion_power : (member ? member.champion_power : 0),
        p_crew_power: update.crew_power !== undefined ? update.crew_power : (member ? member.crew_power : 0),
        p_flagship_power: update.flagship_power !== undefined ? update.flagship_power : (member ? member.flagship_power : 0),
        p_fleet_rating: update.fleet_rating !== undefined ? update.fleet_rating : (member ? member.fleet_rating : 0),
        p_glory_score: update.glory_score !== undefined ? update.glory_score : (member ? member.glory_score : 0)
      });
    } catch (rpcErr) { console.warn('Metrics snapshot RPC fallback', rpcErr); }

    await fetchGuildMembers();
    showToast(t('toast_member_updated'), 'success');
    if (gm && gm.cache && typeof gm.cache.invalidate === 'function') gm.cache.invalidate();
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
  const eligPromise = client.rpc('gm_list_transfer_eligible_guilds', { p_guild: currentG });
  const curPromise = client.from('guilds').select('server_number').eq('id', currentG).maybeSingle();

  let eligibleGuilds: any[] = [];
  try {
    const eligRes = await eligPromise;
    if (eligRes.error) throw eligRes.error;
    eligibleGuilds = eligRes.data || [];
  } catch (err) { console.error('Failed to fetch transfer-eligible guilds', err); }

  if (eligibleGuilds.length === 0) {
    showToast('No other guild is eligible for transfer right now. Set a server number in Super Admin > Subscription Management & Server Numbers, or ask a super admin to open a cross-server migration window.', 'warning');
    return;
  }

  let currentServer: any = null;
  try {
    const curRes = await curPromise;
    currentServer = curRes.data ? curRes.data.server_number : null;
  } catch (err) { console.warn('Failed to fetch current guild server number', err); }

  const optionsHtml = eligibleGuilds.map((gg) => {
    const label = gg.is_same_server
      ? (gg.id + ' (Server #' + gg.server_number + ')')
      : (gg.id + ' (Server #' + gg.server_number + ' — Migration Window)');
    return '<option value="' + esc(gg.id) + '" data-server="' + esc(gg.server_number) + '">' + esc(label) + '</option>';
  }).join('');

  const html =
    '<div id="transfer-member-overlay" class="gm-modal-overlay">' +
      '<div class="gm-modal-card" style="max-width: 480px; width: 90%; position: relative;">' +
        '<div class="gm-modal-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 1rem;">' +
          '<div style="display:flex; align-items:center; gap:0.5rem;"><i class="ph ph-arrows-left-right" style="font-size: var(--fs-3xl); color: var(--accent);"></i><h3 style="margin:0; font-size: var(--fs-xl);">Transfer Member</h3></div>' +
          '<button type="button" class="gm-mini-btn gm-close-modal"><i class="ph ph-x"></i></button>' +
        '</div>' +
        '<div class="gm-modal-body" style="display:flex; flex-direction:column; gap:1rem;">' +
          '<div style="background: rgba(255,255,255,0.03); padding: 0.75rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">' +
            '<div><strong>Player:</strong> <span style="color: var(--accent); font-weight: 700;">' + esc(member.pseudo) + '</span> (UID: ' + esc(member.uid) + ')</div>' +
            '<div style="font-size: var(--fs-base); color: var(--text-dim); margin-top: 0.25rem;">Current Guild: <strong>' + esc(currentG) + '</strong> (Server #' + esc(currentServer) + ')</div>' +
          '</div>' +
          '<div class="gm-form-group">' +
            '<label class="gm-label" style="font-size: var(--fs-base); font-weight: 600; margin-bottom: 0.35rem; display:block;">Select Target Guild:</label>' +
            '<select id="transfer-target-guild" class="gm-select gm-input">' + optionsHtml + '</select>' +
          '</div>' +
        '</div>' +
        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top: 1.5rem;">' +
          '<button type="button" class="gm-btn gm-btn-ghost gm-close-modal">Cancel</button>' +
          '<button type="button" id="confirm-transfer-btn" class="gm-btn gm-btn-primary"><i class="ph ph-arrows-left-right"></i><span>Confirm Transfer</span></button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = byId('transfer-member-overlay');
  if (!overlay) return;
  requestAnimationFrame(() => overlay.classList.add('visible'));
  const closeModal = (): void => { overlay.classList.remove('visible'); setTimeout(() => { overlay.remove(); }, 200); };
  overlay.querySelectorAll('.gm-close-modal').forEach((btn) => btn.addEventListener('click', closeModal));
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });

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
      const res = await client.rpc('transfer_guild_member', { p_uid: member.uid, p_target_guild: targetGuild, p_pseudo: member.pseudo });
      if (res.error) throw res.error;
      if (!res.data || !res.data.ok) throw new Error((res.data && res.data.error) || 'transfer_failed');
      const targetOption = targetSelect!.options[targetSelect!.selectedIndex];
      const targetServer = targetOption ? targetOption.getAttribute('data-server') : currentServer;
      closeModal();
      showToast(member.pseudo + ' transferred to ' + targetGuild + ' on Server #' + targetServer + '!', 'success');
      const gm = g();
      if (gm && gm.cache && typeof gm.cache.invalidate === 'function') gm.cache.invalidate();
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
      const res = await client.from('player_name_history').select('*').eq('uid', member.uid).order('changed_at', { ascending: false });
      if (!res.error) nameHistory = res.data || [];
    } catch (err) { console.error('Fetch name history failed', err); }
  }

  const overlay = document.createElement('div');
  overlay.id = 'edit-member-overlay';
  overlay.className = 'gm-modal-overlay';

  const historyHtml = nameHistory.length > 0
    ? '<div style="margin-top: 1rem; border-top: 1px solid var(--border-soft); padding-top: 1rem; text-align: left;">' +
        '<h4 style="margin: 0 0 0.5rem 0; font-size: var(--fs-md); color: var(--text-muted);"><i class="ph ph-clock-counter-clockwise"></i> ' + t('Name History') + '</h4>' +
        '<div style="max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.35rem;">' +
          nameHistory.map((h) => {
            const date = new Date(h.changed_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
            return '<div style="display: flex; justify-content: space-between; align-items: center; font-size: var(--fs-sm); background: var(--bg-dim); border: 1px solid var(--border-soft); padding: 0.35rem 0.5rem; border-radius: var(--radius-sm);">' +
              '<span><strong>' + esc(h.old_pseudo) + '</strong> ➔ <strong>' + esc(h.new_pseudo) + '</strong> <span class="gm-dim" style="font-size: var(--fs-sm);">(' + date + ' by ' + esc(h.changed_by) + ')</span></span>' +
              '<button type="button" class="delete-history-btn" data-id="' + esc(h.id) + '" style="background: none; border: none; color: var(--error); cursor: pointer; padding: 2px;"><i class="ph ph-trash"></i></button>' +
            '</div>';
          }).join('') +
        '</div></div>'
    : '';

  const gm = g();
  const uidStat = gm && typeof gm.getUidStatus === 'function' ? gm.getUidStatus(member.uid) : { valid: true };
  const isTempUid = !uidStat.valid;
  const uidHelperHtml = isTempUid
    ? '<div id="edit-uid-helper" style="font-size: var(--fs-sm); color:#f87171; margin-top:0.35rem; display:flex; align-items:center; gap:0.25rem;"><i class="ph ph-warning"></i> ' + esc(uidStat.label || '') + ' (' + esc(uidStat.reason || 'Enter real 6-10 digit game UID') + ')</div>'
    : '';

  const metricInput = (id: string, label: string, value: unknown, placeholder: string): string =>
    '<div class="input-group"><label for="' + id + '" style="font-size: var(--fs-sm);">' + label + '</label>' +
    '<input type="number" id="' + id + '" class="gm-input" value="' + esc(value || '') + '" placeholder="' + placeholder + '" style="padding:0.35rem 0.5rem; font-size: var(--fs-sm);"></div>';

  overlay.innerHTML =
    '<div class="gm-modal-card" style="max-width: 480px; width: 95vw;">' +
      '<div class="confirm-icon"><i class="ph-fill ph-pencil-simple text-accent"></i></div>' +
      '<h3>' + t('edit_member_title') + '</h3>' +
      '<p>' + t('edit_member_body') + '</p>' +
      '<form id="edit-member-form" style="display:flex; flex-direction:column; gap: 1rem; margin-top: 1rem;">' +
        '<div class="input-group"><label for="edit-pseudo">' + t('label_pseudo') + '</label><div class="input-wrapper"><i class="ph ph-game-controller"></i>' +
          '<input type="text" id="edit-pseudo" required value="' + esc(member.pseudo) + '"></div></div>' +
        '<div class="input-group"><label for="edit-uid">UID</label><div class="input-wrapper"><i class="ph ph-identification-badge"></i>' +
          '<input type="text" id="edit-uid" value="' + esc(member.uid || '') + '" placeholder="e.g. 1917131" ' + (isTempUid ? 'style="border-color:rgba(239,68,68,0.7);"' : '') + '></div>' + uidHelperHtml + '</div>' +
        '<div style="display: flex; gap: 1rem;">' +
          '<div class="input-group" style="flex: 1;"><label for="edit-power">Overall Power</label><div class="input-wrapper"><i class="ph ph-sword"></i>' +
            '<input type="number" id="edit-power" value="' + esc(member.overall_power || '') + '" placeholder="e.g. 80000000"></div></div>' +
          '<div class="input-group" style="flex: 1;"><label for="edit-role"><i class="ph ph-crown"></i> Role</label>' +
            '<select id="edit-role" style="background: var(--bg-1); border: 1px solid var(--border-soft); color: var(--text-normal); width: 100%; border-radius: var(--radius-md); padding: 0.65rem 0.75rem;">' +
              ['R1', 'R2', 'R3', 'R4', 'R5'].map((r) => '<option value="' + r + '"' + (member.role === r ? ' selected' : '') + '>' + r + '</option>').join('') +
            '</select></div>' +
        '</div>' +
        '<div style="background: var(--bg-dim); border: 1px solid var(--border-soft); border-radius: var(--radius-md); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">' +
          '<div style="font-size: var(--fs-sm); font-weight: 700; color: var(--accent);"><i class="ph ph-crosshair"></i> Tactical Military Scores</div>' +
          '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.5rem;">' +
            metricInput('edit-fleet', '⚔️ Fleet Rating', member.fleet_rating, 'e.g. 2000000') +
            metricInput('edit-tech', '🔬 Tech Power', member.tech_power, 'e.g. 15000000') +
            metricInput('edit-flagship', '🚀 Flagship Power', member.flagship_power, 'e.g. 10000000') +
            metricInput('edit-champ', '👑 Champions Power', member.champion_power, 'e.g. 30000000') +
            metricInput('edit-crew', '👥 Crew Power', member.crew_power, 'e.g. 5000000') +
            metricInput('edit-glory', '🏆 Glory Score', member.glory_score, 'e.g. 50000000') +
          '</div>' +
        '</div>' + historyHtml +
        '<div class="confirm-actions">' +
          '<button type="button" id="edit-cancel" class="gm-btn gm-btn-ghost">' + t('confirm_cancel') + '</button>' +
          '<button type="submit" class="gm-btn gm-btn-primary">' + t('confirm_ok') + '</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const close = (): void => { overlay.classList.remove('visible'); setTimeout(() => { overlay.remove(); }, 300); };
  const cancelBtn = byId('edit-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  const editUidInput = byId<HTMLInputElement>('edit-uid');
  if (editUidInput) {
    editUidInput.addEventListener('input', () => {
      const st = gm && typeof gm.getUidStatus === 'function' ? gm.getUidStatus(editUidInput.value.trim()) : { valid: true };
      const helper = byId('edit-uid-helper');
      if (!st.valid) {
        editUidInput.style.borderColor = 'rgba(239,68,68,0.7)';
        if (helper) { helper.style.display = 'flex'; helper.innerHTML = '<i class="ph ph-warning"></i> ' + esc(st.label || '') + ' (' + esc(st.reason || 'Enter real 6-10 digit game UID') + ')'; }
      } else {
        editUidInput.style.borderColor = 'rgba(52,211,153,0.7)';
        if (helper) helper.style.display = 'none';
      }
    });
  }

  overlay.querySelectorAll('.delete-history-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id') || '';
      const res = await client.from('player_name_history').delete().eq('id', id);
      if (!res.error) { (btn as HTMLElement).closest('div')?.remove(); showToast('History entry removed', 'success'); }
      else showToast('Error removing history entry', 'error');
    });
  });

  const form = byId<HTMLFormElement>('edit-member-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = (id: string): string => { const el = byId<HTMLInputElement>(id); return el ? el.value : ''; };
      const extraMetrics = {
        fleet_rating: parseInt(val('edit-fleet')) || 0,
        tech_power: parseInt(val('edit-tech')) || 0,
        flagship_power: parseInt(val('edit-flagship')) || 0,
        champion_power: parseInt(val('edit-champ')) || 0,
        crew_power: parseInt(val('edit-crew')) || 0,
        glory_score: parseInt(val('edit-glory')) || 0
      };
      const ok = await renameGuildMember(member.pseudo, val('edit-pseudo'), val('edit-uid'), val('edit-power'), val('edit-role'), extraMetrics);
      if (ok) close();
    });
  }
}
