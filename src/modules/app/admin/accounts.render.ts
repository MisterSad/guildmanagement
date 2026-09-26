/**
 * src/modules/app/admin/accounts.render.ts
 *
 * Sous-lot 6.5 (Strangler) — admin account rendering ported from app.js:
 * renderAccounts, renderSuperAdminGroupedAccounts, renderAccountCardsToContainer
 * and wireAccountCardListeners (renew password, reset passkeys, copy, delete,
 * role/guild selects). All dynamic values go through esc().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { t, esc, gm, winAny, byId } from './utils';
import {
  type AccountRow,
  getAccounts,
  findAccount,
  setPendingPassword,
  getPendingPassword,
  updateAccountRole,
  updateAccountGuild,
  getServerNumberForGuild
} from './admin-store';
import { deleteAccount, fetchAccounts } from './accounts.controller';
import { renderPendingRegistrations } from './guild-requests.controller';

function isSuperAdminUser(): boolean {
  const g = gm();
  return !!g && typeof g.roleFromStorage === 'function' && g.roleFromStorage() === 'super_admin';
}

export function renderAccounts(): void {
  const w = winAny();
  const activeG = w.currentGuild || 'ALPHA';
  const activeGUpper = String(activeG || '').trim().toUpperCase();
  const superAdmin = isSuperAdminUser();
  const accounts = getAccounts();

  void renderPendingRegistrations(activeG);

  const activeAccounts = accounts.filter((acc) => {
    if (acc.status === 'pending') return false;
    const accGuild = acc.guild || 'ALPHA';
    if (acc.role === 'super_admin') return true;
    return String(accGuild).trim().toUpperCase() === activeGUpper;
  });

  const adminAccountsList = activeAccounts.filter((acc) => acc.role !== 'member');
  const memberAccountsList = activeAccounts.filter((acc) => acc.role === 'member');

  const containerAdmin = byId('account-list');
  const countAdmin = byId('account-count');
  if (containerAdmin) renderAccountCardsToContainer(containerAdmin, countAdmin, adminAccountsList, superAdmin);

  const containerMember = byId('member-account-list');
  const countMember = byId('member-account-count');
  if (containerMember) renderAccountCardsToContainer(containerMember, countMember, memberAccountsList, superAdmin);

  const containerR5 = byId('superadmin-account-list');
  const countR5 = byId('superadmin-account-count');
  if (containerR5) {
    const listR5 = accounts.filter((acc) =>
      acc.role === 'guild_admin' || acc.role === 'server_admin' || acc.role === 'super_admin'
    );
    listR5.sort((a, b) => {
      const gA = a.guild || '';
      const gB = b.guild || '';
      if (gA !== gB) return gA.localeCompare(gB);
      return a.id.localeCompare(b.id);
    });
    renderSuperAdminGroupedAccounts(containerR5, countR5, listR5, superAdmin);
  }
}

export function renderSuperAdminGroupedAccounts(
  container: HTMLElement | null,
  countEl: HTMLElement | null,
  listToRender: AccountRow[],
  superAdmin: boolean
): void {
  if (!container) return;
  if (countEl) countEl.textContent = String(listToRender.length);

  if (listToRender.length === 0) {
    container.innerHTML = '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_accounts') + '</div></div>';
    return;
  }

  const groupedByServer: Record<string, { serverKey: string; sNum: string; accounts: AccountRow[]; guildsSet: Record<string, boolean> }> = {};
  listToRender.forEach((acc) => {
    const g = acc.guild || '';
    const sNum = acc.server_number || (g ? getServerNumberForGuild(g) : '');
    const sKey = sNum ? ('Server #' + sNum) : (acc.role === 'super_admin' ? 'Super Admin Master Accounts' : 'Unassigned Server');
    if (!groupedByServer[sKey]) groupedByServer[sKey] = { serverKey: sKey, sNum: String(sNum || ''), accounts: [], guildsSet: {} };
    groupedByServer[sKey].accounts.push(acc);
    if (g) groupedByServer[sKey].guildsSet[g] = true;
  });

  const serverKeys = Object.keys(groupedByServer).sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, ''), 10) || 999999;
    const numB = parseInt(b.replace(/\D/g, ''), 10) || 999999;
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });

  let html = '';
  serverKeys.forEach((sKey, index) => {
    const group = groupedByServer[sKey];
    const guildsListStr = Object.keys(group.guildsSet).sort().join(', ');
    const accCount = group.accounts.length;
    const isFirst = index === 0;

    html +=
      '<div class="gm-card glass-card" style="margin-bottom:1rem; padding:0; overflow:hidden;">' +
        '<div class="gm-accordion-header" style="padding:0.9rem 1.2rem; display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-soft); transition:background 0.2s ease;">' +
          '<div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">' +
            '<span style="background:rgba(59, 130, 246, 0.15); color:#60a5fa; border:1px solid rgba(59, 130, 246, 0.3); border-radius:6px; padding:3px 10px; font-weight:800; font-size: var(--fs-base); font-family:var(--font-display);">' +
              '<i class="ph ph-hard-drives" style="margin-right:4px;"></i>' + esc(sKey) +
            '</span>' +
            '<span style="font-weight:700; color:var(--fg); font-size: var(--fs-md);">' + esc(guildsListStr || 'All Tenants') + '</span>' +
            '<span class="gm-badge" style="background:var(--accent-soft); color:var(--accent); font-weight:700; font-size: var(--fs-sm);">' + accCount + ' admin' + (accCount > 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<i class="ph ph-caret-down gm-accordion-arrow" style="font-size: var(--fs-xl); color:var(--fg-dim); transition:transform 0.25s ease;' + (isFirst ? ' transform:rotate(180deg);' : '') + '"></i>' +
        '</div>' +
        '<div class="gm-accordion-body" style="padding:1rem 1.25rem;' + (isFirst ? ' display:block;' : ' display:none;') + '">' +
          '<div id="acc-grid-' + index + '" class="gm-account-grid"></div>' +
        '</div>' +
      '</div>';
  });

  container.innerHTML = html;

  serverKeys.forEach((sKey, index) => {
    const gridEl = byId('acc-grid-' + index);
    if (gridEl) renderAccountCardsToContainer(gridEl, null, groupedByServer[sKey].accounts, superAdmin);
  });

  container.querySelectorAll('.gm-accordion-header').forEach((headerEl) => {
    headerEl.addEventListener('click', () => {
      const bodyEl = headerEl.nextElementSibling as HTMLElement | null;
      const arrowEl = headerEl.querySelector('.gm-accordion-arrow') as HTMLElement | null;
      if (!bodyEl) return;
      const isHidden = (bodyEl.style.display === 'none');
      if (isHidden) {
        bodyEl.style.display = 'block';
        if (arrowEl) arrowEl.style.transform = 'rotate(180deg)';
      } else {
        bodyEl.style.display = 'none';
        if (arrowEl) arrowEl.style.transform = 'rotate(0deg)';
      }
    });
  });
}

export function renderAccountCardsToContainer(
  container: HTMLElement | null,
  countEl: HTMLElement | null,
  listToRender: AccountRow[],
  superAdmin: boolean
): void {
  if (!container) return;
  if (countEl) countEl.textContent = String(listToRender.length);

  if (listToRender.length === 0) {
    container.innerHTML = '<div class="gm-empty"><i class="ph ph-ghost gm-icon"></i><div class="gm-empty-title">' + t('empty_accounts') + '</div></div>';
    return;
  }

  let html = '<div class="gm-cred-grid">';
  listToRender.forEach((acc) => {
    const role = acc.role || 'guild_admin';
    let roleLabel = 'Guild Admin';
    let chipCls = 'gm-chip-info';

    if (role === 'super_admin') { roleLabel = 'Super Admin'; chipCls = 'gm-chip-accent'; }
    else if (role === 'server_admin') { roleLabel = 'Server Admin'; chipCls = 'gm-chip-warning'; }
    else if (role === 'member') { roleLabel = 'Member'; chipCls = 'gm-chip-lilac'; }

    const dateStr = acc.created_at
      ? new Date(acc.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '-';
    const guildLabel = acc.guild ? 'Guild: ' + acc.guild : 'All Guilds';
    const guildCls = acc.guild ? 'gm-chip-warning' : 'gm-chip-success';

    const isSuperAdminAccount = (role === 'super_admin');
    const canManagePass = superAdmin || !isSuperAdminAccount;
    const canDelete = superAdmin || !isSuperAdminAccount;

    let passHtml = '';
    if (canManagePass) {
      passHtml = '<div class="gm-cred-pass gm-masked" data-acc-id="' + esc(acc.id) + '">' +
        '<span class="gm-pwd-text">••••••••••••</span>' +
        '<button class="gm-mini-btn gm-cred-reset" title="Renew Password"><i class="ph ph-arrows-clockwise"></i></button>' +
        '<button class="gm-mini-btn gm-cred-copy hidden" title="Copy Password"><i class="ph ph-copy"></i></button>' +
        '<button class="gm-mini-btn gm-cred-reset-passkeys" title="Reset Passkeys (revoke all passkeys + backup codes)"><i class="ph ph-fingerprint"></i></button>' +
      '</div>';
    } else {
      passHtml = '<div class="gm-cred-pass gm-masked" style="opacity: 0.6; cursor: not-allowed;" title="Protected Super Admin Account">' +
        '<span class="gm-pwd-text">••••••••••••</span>' +
      '</div>';
    }

    let deleteHtml = '';
    if (canDelete) {
      deleteHtml = '<button class="gm-mini-btn gm-danger gm-cred-delete" data-id="' + esc(acc.id) + '" title="' + t('delete_title') + '" style="margin-left:auto;">' +
        '<i class="ph ph-trash"></i>' +
      '</button>';
    }

    let roleSelectHtml = '';
    let guildSelectHtml = '';
    if (superAdmin) {
      roleSelectHtml = '<select class="gm-select gm-select-sm gm-account-role-select" data-id="' + esc(acc.id) + '" style="font-size: var(--fs-sm); padding: 0.15rem 0.4rem; height: auto; width: auto; min-width: 105px; border-radius: 4px; line-height: 1.2; font-weight: 600;">' +
        '<option value="guild_admin"' + (role === 'guild_admin' ? ' selected' : '') + '>Guild Admin</option>' +
        '<option value="server_admin"' + (role === 'server_admin' ? ' selected' : '') + '>Server Admin</option>' +
        '<option value="super_admin"' + (role === 'super_admin' ? ' selected' : '') + '>Super Admin</option>' +
        '<option value="member"' + (role === 'member' ? ' selected' : '') + '>Member</option>' +
      '</select>';

      let options = '<option value="ALL"' + (!acc.guild ? ' selected' : '') + '>All Guilds</option>';
      (winAny().guildsList || []).forEach((g: string) => {
        options += '<option value="' + esc(g) + '"' + (acc.guild === g ? ' selected' : '') + '>' + esc(g) + '</option>';
      });
      guildSelectHtml = '<select class="gm-select gm-select-sm gm-account-guild-select" data-id="' + esc(acc.id) + '" style="font-size: var(--fs-sm); padding: 0.15rem 0.4rem; height: auto; width: auto; min-width: 90px; border-radius: 4px; line-height: 1.2;">' +
        options +
      '</select>';
    } else {
      roleSelectHtml = '<span class="gm-chip ' + chipCls + '">' + esc(roleLabel) + '</span>';
      guildSelectHtml = '<span class="gm-chip ' + guildCls + '" style="font-size: var(--fs-xs);">' + esc(guildLabel) + '</span>';
    }

    html +=
      '<div class="gm-cred-card" data-acc-id="' + esc(acc.id) + '">' +
        '<div class="gm-row" style="justify-content:space-between; margin-bottom: 0.25rem;">' +
          '<div class="gm-cred-name">' + esc(acc.id) + '</div>' +
          '<div class="gm-row" style="gap: 0.25rem; align-items: center;">' +
            roleSelectHtml +
            guildSelectHtml +
          '</div>' +
        '</div>' +
        passHtml +
        '<div class="gm-row gm-dim" style="font-size: var(--fs-sm);">' +
          '<i class="ph ph-calendar-blank"></i>' +
          '<span>' + t('cred_created') + ' ' + dateStr + '</span>' +
          deleteHtml +
        '</div>' +
      '</div>';
  });
  html += '</div>';
  container.innerHTML = html;

  wireAccountCardListeners(container);
}

export function wireAccountCardListeners(container: HTMLElement | null): void {
  if (!container) return;

  container.querySelectorAll('.gm-cred-reset').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wrap = btn.closest('.gm-cred-pass') as HTMLElement | null;
      if (!wrap) return;
      const accId = wrap.getAttribute('data-acc-id') || '';
      const pwdSpan = wrap.querySelector('.gm-pwd-text');
      const copyBtn = wrap.querySelector('.gm-cred-copy');
      const icon = btn.querySelector('i');

      (btn as HTMLButtonElement).disabled = true;
      if (icon) icon.className = 'ph ph-circle-notch ph-spin';

      try {
        const g = gm();
        const res = await g.adminAccounts('reset-password', { id: accId });
        if (!res.ok) throw new Error(res.error || 'reset_failed');
        const pass = res.password;
        setPendingPassword(accId, pass);
        wrap.setAttribute('data-acc-pass-temp', pass);
        wrap.classList.remove('gm-masked');
        if (pwdSpan) pwdSpan.textContent = pass;
        if (copyBtn) copyBtn.classList.remove('hidden');
        if (navigator.clipboard) navigator.clipboard.writeText(pass).catch(() => undefined);
        g.showToast ? g.showToast('Password renewed: ' + pass + ' (copied to clipboard)', 'success') : undefined;
      } catch (err: any) {
        const g = gm();
        if (g && g.showToast) g.showToast(t('toast_err_generic') + ' ' + err.message, 'error');
      } finally {
        (btn as HTMLButtonElement).disabled = false;
        if (icon) icon.className = 'ph ph-arrows-clockwise';
      }
    });
  });

  container.querySelectorAll('.gm-cred-reset-passkeys').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.gm-cred-pass');
      const accId = wrap ? wrap.getAttribute('data-acc-id') || '' : '';
      const w = winAny();
      if (!w.showConfirm) return;
      w.showConfirm(
        'Reset Passkeys',
        'This revokes <strong>all</strong> passkeys and backup codes for <strong>' + esc(accId) + '</strong>. They will need to sign in with their password and set up passkeys again. Continue?',
        async () => {
          const icon = btn.querySelector('i');
          const originalClass = icon ? icon.className : '';
          (btn as HTMLButtonElement).disabled = true;
          if (icon) icon.className = 'ph ph-circle-notch ph-spin';
          try {
            const g = gm();
            const res = await g.webauthn.adminResetPasskeys(accId);
            if (!res.ok) throw new Error(res.error || 'reset_failed');
            if (g.showToast) g.showToast('Passkeys reset for ' + accId + '.', 'success');
          } catch (err: any) {
            const g = gm();
            if (g && g.showToast) g.showToast('Could not reset passkeys: ' + err.message, 'error');
          } finally {
            (btn as HTMLButtonElement).disabled = false;
            if (icon) icon.className = originalClass;
          }
        }
      );
    });
  });

  container.querySelectorAll('.gm-cred-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.gm-cred-pass');
      const accId = wrap ? wrap.getAttribute('data-acc-id') || '' : '';
      const pass = getPendingPassword(accId) || (wrap ? wrap.getAttribute('data-acc-pass-temp') : '');
      if (!pass || !navigator.clipboard) return;
      navigator.clipboard.writeText(pass).then(() => {
        const icon = btn.querySelector('i');
        if (icon) icon.className = 'ph ph-check';
        const g = gm();
        if (g && g.showToast) g.showToast('Password copied to clipboard.', 'success');
        setTimeout(() => { if (icon) icon.className = 'ph ph-copy'; }, 2000);
      });
    });
  });

  container.querySelectorAll('.gm-cred-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id') || '';
      const w = winAny();
      if (!w.showConfirm) return;
      w.showConfirm(
        t('confirm_delete_account_title'),
        t('confirm_delete_account_body') + ' <strong>' + esc(id) + '</strong>' + t('confirm_delete_account_body2'),
        () => { void deleteAccount(id); }
      );
    });
  });

  container.querySelectorAll('.gm-account-role-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = sel.getAttribute('data-id') || '';
      const newRole = (sel as HTMLSelectElement).value;
      const acc = findAccount(id);
      (sel as HTMLSelectElement).disabled = true;
      try {
        const g = gm();
        const res = await g.adminAccounts('update-role', { id, role: newRole, guild: acc ? acc.guild : null });
        if (!res.ok) throw new Error(res.error || 'update_failed');
        if (g.showToast) g.showToast('Role for ' + id + ' updated to ' + newRole + ' successfully!', 'success');
        updateAccountRole(id, newRole, res.server_number);
        renderAccounts();
      } catch (err: any) {
        const g = gm();
        if (g && g.showToast) g.showToast('Error updating role: ' + err.message, 'error');
        void fetchAccounts();
      } finally {
        (sel as HTMLSelectElement).disabled = false;
      }
    });
  });

  container.querySelectorAll('.gm-account-guild-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = sel.getAttribute('data-id') || '';
      const newGuild = (sel as HTMLSelectElement).value;
      (sel as HTMLSelectElement).disabled = true;
      try {
        const g = gm();
        const res = await g.adminAccounts('update-guild', { id, guild: newGuild });
        if (!res.ok) throw new Error(res.error || 'update_failed');
        if (g.showToast) g.showToast('Access for ' + id + ' updated successfully!', 'success');
        updateAccountGuild(id, newGuild === 'ALL' ? null : newGuild);
        renderAccounts();
      } catch (err: any) {
        const g = gm();
        if (g && g.showToast) g.showToast('Error updating: ' + err.message, 'error');
        void fetchAccounts();
      } finally {
        (sel as HTMLSelectElement).disabled = false;
      }
    });
  });
}
