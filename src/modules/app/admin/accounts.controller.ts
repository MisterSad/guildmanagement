/**
 * src/modules/app/admin/accounts.controller.ts
 *
 * Sous-lot 6.5 (Strangler) — admin accounts/guilds controller ported from
 * app.js: fetchAccounts/deleteAccount, fetchGuilds, populateAccountGuildSelect,
 * the create account/admin/guild forms, and wireJoinCode.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { t, esc, byId, getDb, ls } from './utils';
import { getActiveGuild, isSuperAdmin, currentAccountId } from '../../../core/auth/roles';
import { adminAccounts, generateJoinCode } from '../../../core/auth/session';
import { buildInviteLink } from '../../../core/auth/pending-intent';
import { setAccounts, filterAccountsOut, unshiftAccount, getAccounts } from './admin-store';
import { renderAccounts, revealAccountPassword } from './accounts.render';
import { showToast } from '../dialogs/dialogs.service';
import { shellView } from '../../shell/views/ShellView';
import { getAppState, patchAppState } from '../../../core/state/app-state';
import { queryGuildList, insertGuild } from './admin.service';

export async function fetchAccounts(): Promise<void> {
  try {
    const res = await adminAccounts('list');
    if (!res.ok) throw new Error(res.error || 'list_failed');
    setAccounts(res.accounts || []);
    renderAccounts();
  } catch (err: any) {
    showToast(t('toast_err_fetch_accounts') + ' ' + err.message, 'error');
  }
}

export async function deleteAccount(id: string): Promise<void> {
  try {
    const res = await adminAccounts('delete', { id });
    if (!res.ok) throw new Error(res.error || 'delete_failed');
    filterAccountsOut(id);
    renderAccounts();
    showToast(t('toast_account_deleted'), 'success');
  } catch (err: any) {
    showToast(t('toast_err_generic') + ' ' + err.message, 'error');
  }
}

export async function fetchGuilds(): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const res = await queryGuildList(db);
    if (res.error) return;
    const data = res.data;
    if (data && data.length > 0) {
      const guildsData: Record<string, { server_number?: string | null }> = {};
      data.forEach((g: any) => {
        const sNum = g.server_number || (ls() ? ls()!.getItem('gm_server_number_' + g.id) : '') || '';
        guildsData[g.id] = { server_number: sNum };
      });
      patchAppState({ guildsList: data.map((g: any) => g.id), guildsData });
      // Phase 7: the guild map has just changed, so the chrome that displays it
      // is re-rendered directly rather than through two `window` probes that
      // skipped the refresh whenever a name drifted.
      shellView.renderTopbar();
      shellView.renderSidebar();
      populateAccountGuildSelect();
    }
  } catch (err) {
    console.error('Failed to fetch guilds list', err);
  }
}

export function populateAccountGuildSelect(): void {
  const st = getAppState();
  const selectR4 = byId<HTMLSelectElement>('account-guild');
  if (selectR4) {
    // H2: offering 'ALPHA' here let an admin create an account in a tenant
    // they never chose. With nothing resolved the select stays empty.
    const myGuild = getActiveGuild();
    selectR4.innerHTML = myGuild
      ? '<option value="' + esc(myGuild) + '">' + esc(myGuild) + '</option>'
      : '<option value="">' + esc(t('guild_unresolved')) + '</option>';
    selectR4.value = myGuild || '';
    selectR4.disabled = true;
  }

  // Phase D5 invitation card: a guild_admin can only invite into their own
  // guild, so the select collapses to one locked option for them; anyone with
  // wider scope gets the full list. The server re-checks either way
  // (isGuildInScope), this only keeps the UI honest.
  const inviteGuild = byId<HTMLSelectElement>('admin-invite-guild');
  if (inviteGuild) {
    const restriction = st.currentGuildRestriction;
    if (restriction) {
      inviteGuild.innerHTML = '<option value="' + esc(restriction) + '">' + esc(restriction) + '</option>';
      inviteGuild.value = restriction;
      inviteGuild.disabled = true;
    } else {
      inviteGuild.disabled = false;
      inviteGuild.innerHTML = (st.guildsList || []).map((g: string) => {
        const entry = st.guildsData ? st.guildsData[g] : undefined;
        const sNum = (entry && entry.server_number) ? ' (#' + entry.server_number + ')' : '';
        return '<option value="' + esc(g) + '">' + esc(g) + sNum + '</option>';
      }).join('');
    }
  }

  // The role ceiling mirrors maxAssignableRole() on the server: a guild_admin
  // and a server_admin may only ever mint a guild_admin.
  const inviteRole = byId<HTMLSelectElement>('admin-invite-role');
  if (inviteRole) {
    const isSuper = isSuperAdmin();
    inviteRole.innerHTML = isSuper
      ? '<option value="guild_admin">guild_admin</option>' +
        '<option value="server_admin">server_admin</option>' +
        '<option value="super_admin">super_admin</option>'
      : '<option value="guild_admin">guild_admin</option>';
  }

  const selectR5 = byId<HTMLSelectElement>('superadmin-account-guild');
  if (selectR5) {
    let html = '';
    (st.guildsList || []).forEach((g: string) => {
      const entry = st.guildsData ? st.guildsData[g] : undefined;
      const sNum = (entry && entry.server_number) ? ' (#' + entry.server_number + ')' : '';
      html += '<option value="' + esc(g) + '">' + esc(g) + sNum + '</option>';
    });
    selectR5.innerHTML = html;
  }
}

/**
 * Phase D5 — issue a single-use admin invitation.
 *
 * The plaintext is returned once and never stored, so it is surfaced inline
 * and copied to the clipboard immediately. Idempotent wiring: the form is
 * re-rendered whenever the accounts tab loads.
 */
export function wireAdminInvite(): void {
  const form = byId<HTMLFormElement>('admin-invite-form');
  if (!form || (form as any).__gmInviteWired) return;
  (form as any).__gmInviteWired = true;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const guildSel = byId<HTMLSelectElement>('admin-invite-guild');
    const roleSel = byId<HTMLSelectElement>('admin-invite-role');
    const result = byId('admin-invite-result');
    const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    const guild = guildSel ? guildSel.value : '';
    const role = roleSel ? roleSel.value : 'guild_admin';
    if (!guild) { showToast('Pick a guild first.', 'error'); return; }

    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await adminAccounts('issue-admin-invite', { guild: guild, role: role });
      if (!res.ok) {
        if (res.error === 'too_many_open_codes') {
          showToast('That guild already has ' + (res.open_codes ?? 'too many') + ' unused invitations. Wait for one to be used or to expire.', 'error');
        } else if (res.error === 'forbidden') {
          showToast('You cannot invite that role into that guild.', 'error');
        } else {
          showToast('Could not issue an invitation: ' + res.error, 'error');
        }
        return;
      }

      if (result) {
        result.innerHTML =
          '<div class="gm-cred-pass" style="display:inline-flex;">' +
            '<span class="gm-pwd-text">' + esc(res.invite_code) + '</span>' +
            '<button class="gm-mini-btn gm-invite-copy" title="Copy invitation code"><i class="ph ph-copy"></i></button>' +
            '<button class="gm-mini-btn gm-invite-link-copy" title="Copy invite link"><i class="ph ph-link"></i></button>' +
          '</div>' +
          '<div style="margin-top:.4rem; font-size:.78rem; color:var(--text-dim);">' +
            esc(String(res.open_codes)) + ' of ' + esc(String(res.max_open_codes)) + ' invitations open for ' + esc(guild) + '. Shown once.' +
          '</div>';
        const linkCopyBtn = result.querySelector('.gm-invite-link-copy');
        if (linkCopyBtn) linkCopyBtn.addEventListener('click', () => { copyInviteLink('code', res.invite_code); });
        const copyBtn = result.querySelector('.gm-invite-copy');
        if (copyBtn) copyBtn.addEventListener('click', () => {
          if (navigator.clipboard) navigator.clipboard.writeText(res.invite_code)
            .then(() => showToast('Invitation code copied.', 'success')).catch(() => undefined);
        });
      }
      if (navigator.clipboard) navigator.clipboard.writeText(res.invite_code).catch(() => undefined);
      showToast('Invitation for ' + guild + ' created and copied — relay it via Discord.', 'success');
    } catch (err: any) {
      showToast('Could not issue an invitation: ' + (err && err.message ? err.message : 'unknown error'), 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

/**
 * H2: returns null when no tenant is resolved, rather than keying the cache on
 * 'ALPHA'. A join code is a per-guild secret; caching one under a guessed guild
 * meant an unresolved session could read back, and display, another tenant's
 * code.
 */
function joinCodeStorageKey(): string | null {
  const guild = getActiveGuild();
  return guild ? 'gm_join_code_plain_' + guild : null;
}

/** Guild join-code card (permanent code, generated once, persisted server-side). */
/**
 * Copies a shareable invite link to the clipboard. The code rides in the URL
 * FRAGMENT (see core/auth/pending-intent.ts), so it never reaches a server log.
 */
function copyInviteLink(kind: 'join' | 'code', code: string): void {
  const link = buildInviteLink(window.location.origin, kind, code);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link)
      .then(() => showToast("Invite link copied — share it on your guild's Discord.", 'success'))
      .catch(() => undefined);
  }
}

export function wireJoinCode(): void {
  const copyBtn = byId<HTMLButtonElement>('join-code-copy-btn');
  const linkBtn = byId<HTMLButtonElement>('join-link-copy-btn');
  const resultBox = byId('join-code-result');
  const resultVal = byId('join-code-value');
  const infoEl = byId('join-code-info');
  if (!resultVal) return;

  let currentCode = '';

  function showCode(code: string): void {
    currentCode = code || '';
    resultVal!.textContent = code || 'No code yet';
    if (resultBox) {
      if (code) {
        resultBox.classList.remove('gm-join-code-empty');
        if (copyBtn) copyBtn.classList.remove('hidden');
        if (linkBtn) linkBtn.classList.remove('hidden');
      } else {
        resultBox.classList.add('gm-join-code-empty');
        if (copyBtn) copyBtn.classList.add('hidden');
        if (linkBtn) linkBtn.classList.add('hidden');
      }
    }
  }

  function setInfo(text: string): void {
    if (infoEl) infoEl.textContent = text;
  }

  async function loadJoinCode(): Promise<void> {
    const guild = getActiveGuild();
    if (!guild) {
      // H2: asking the server for 'ALPHA's join code was never intended.
      showToast(t('guild_unresolved'), 'error');
      return;
    }
    try {
      const res = await adminAccounts('get-join-code', { guild });
      if (!res.ok) throw new Error(res.error || 'get_code_failed');
      if (res.code) {
        showCode(res.code);
        setInfo("This is your guild's permanent join code. Share it with your players.");
      } else {
        const generatedCode = generateJoinCode('FGF');
        const setRes = await adminAccounts('set-join-code', { code: generatedCode, guild });
        if (!setRes.ok) throw new Error(setRes.error || 'set_code_failed');
        try {
          const key = joinCodeStorageKey();
          if (key) ls()?.setItem(key, generatedCode);
        } catch (_) { /* ignore */ }
        showCode(generatedCode);
        setInfo("This is your guild's permanent join code. Share it with your players.");
        showToast('Join code created.', 'success');
      }
    } catch (_err) {
      let storedCode = '';
      try {
        const key = joinCodeStorageKey();
        storedCode = key ? (ls()?.getItem(key) || '') : '';
      } catch (_) { /* ignore */ }
      if (storedCode) {
        showCode(storedCode);
        setInfo("This is your guild's permanent join code. Share it with your players.");
      } else {
        showCode('');
        setInfo('Unable to load the join code.');
      }
    }
  }

  void loadJoinCode();

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const code = currentCode || (resultVal ? resultVal.textContent : '') || '';
      if (!code || code === 'No code yet') return;
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => { showToast('Join code copied.', 'success'); }).catch(() => undefined);
    });
  }
  if (linkBtn && !(linkBtn as any).__gmLinkWired) {
    (linkBtn as any).__gmLinkWired = true;
    linkBtn.addEventListener('click', () => {
      if (currentCode) copyInviteLink('join', currentCode);
    });
  }
}

function submitButton(form: HTMLFormElement): HTMLButtonElement | null {
  return form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
}

async function onCreateAccountSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const idInput = byId<HTMLInputElement>('account-id');
  const identifier = idInput ? idInput.value.trim() : '';
  if (!identifier) return;

  const guildInput = byId<HTMLSelectElement>('account-guild');
  const guildSelected = guildInput ? guildInput.value : 'ALL';

  if (getAccounts().some((a) => String(a.id).toLowerCase() === identifier.toLowerCase())) {
    showToast(t('toast_duplicate_account'), 'error');
    return;
  }

  const btn = submitButton(form);
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span') : null;
  if (span) span.textContent = t('btn_generating');

  try {
    const res = await adminAccounts('create', {
      id: identifier,
      role: 'guild_admin',
      guild: (guildSelected === 'ALL' ? null : guildSelected),
      created_by: currentAccountId()
    });
    if (!res.ok || !res.password) throw new Error(createErrorMessage(res.error));
    unshiftAccount({
      id: identifier,
      role: 'guild_admin',
      guild: (guildSelected === 'ALL' ? null : guildSelected),
      created_at: new Date().toISOString()
    });
    renderAccounts();
    revealAccountPassword(identifier, res.password);
    if (idInput) idInput.value = '';
    showToast(t('toast_account_created') + ' Password: ' + res.password + ' (copied to clipboard, shown only this once)', 'success');
  } catch (err: any) {
    showToast(err.message || t('toast_err_create'), 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = t('btn_generate');
  }
}

// The server refuses an id that is already taken (case-insensitively), even
// when the local list is stale and the check above let it through.
function createErrorMessage(code: string | undefined): string {
  if (code === 'account_exists') return t('toast_duplicate_account');
  return code || 'create_failed';
}

async function onCreateAdminAccountSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const idInput = byId<HTMLInputElement>('superadmin-account-id');
  const identifier = idInput ? idInput.value.trim() : '';
  if (!identifier) return;

  const roleInput = byId<HTMLSelectElement>('superadmin-account-role');
  const roleSelected = roleInput ? roleInput.value : 'guild_admin';
  const guildInput = byId<HTMLSelectElement>('superadmin-account-guild');
  const guildSelected = guildInput ? guildInput.value : null;

  if (getAccounts().some((a) => String(a.id).toLowerCase() === identifier.toLowerCase())) {
    showToast(t('toast_duplicate_account'), 'error');
    return;
  }

  const btn = submitButton(form);
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span') : null;
  const origText = span ? span.textContent : '';
  if (span) span.textContent = 'Creating...';

  try {
    const res = await adminAccounts('create', { id: identifier, role: roleSelected, guild: guildSelected });
    if (!res.ok || !res.password) throw new Error(createErrorMessage(res.error));
    unshiftAccount({ id: identifier, role: roleSelected, guild: guildSelected, created_at: new Date().toISOString() });
    renderAccounts();
    revealAccountPassword(identifier, res.password);
    if (idInput) idInput.value = '';
    showToast('Admin account ' + identifier + ' (' + roleSelected + ') created for guild ' + guildSelected + '!', 'success');
  } catch (err: any) {
    showToast(err.message || 'Error creating admin account', 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = origText;
  }
}

async function onCreateGuildSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const nameInput = byId<HTMLInputElement>('guild-name-input');
  const serverInput = byId<HTMLInputElement>('guild-server-input');
  const guildName = nameInput ? nameInput.value.trim().toUpperCase() : '';
  const serverNum = serverInput ? serverInput.value.trim() : '';
  if (!guildName) return;

  if (!/^\d{4}$/.test(serverNum)) { showToast('Server number must be exactly 4 digits (e.g. 1089).', 'error'); return; }
  if (/[^A-Z0-9_]/.test(guildName)) { showToast('Guild name must contain uppercase letters, numbers, or underscores.', 'error'); return; }
  if ((getAppState().guildsList || []).indexOf(guildName) !== -1) { showToast('This guild already exists!', 'error'); return; }

  const btn = submitButton(form);
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span') : null;
  const origText = span ? span.textContent : '';
  if (span) span.textContent = 'Creating...';

  try {
    const db = getDb();
    const { error } = await insertGuild(db, guildName, serverNum);
    if (error) throw error;
    showToast('Guild ' + guildName + ' (Server #' + serverNum + ') created successfully!', 'success');
    if (nameInput) nameInput.value = '';
    if (serverInput) serverInput.value = '';
    await fetchGuilds();
  } catch (err: any) {
    showToast('Error creating guild: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = origText;
  }
}

/** Wires the account/admin/guild creation forms. Idempotent per element. */
export function initAccountsUi(): void {
  const wire = (id: string, handler: (e: Event) => void): void => {
    const form = byId<HTMLFormElement>(id);
    if (!form || (form as any).__gmAdminWired) return;
    (form as any).__gmAdminWired = true;
    form.addEventListener('submit', handler);
  };
  wire('create-account-form', (e) => { void onCreateAccountSubmit(e); });
  wire('create-admin-account-form', (e) => { void onCreateAdminAccountSubmit(e); });
  wire('create-guild-form', (e) => { void onCreateGuildSubmit(e); });
}

// ── Recovery codes ───────────────────────────────────────────────────────────
//
// The super_admin is the only account `auth-discord`'s `backup-login` accepts a
// code from, because every other account has an administrator above it who can
// unlink it and issue a relink code. That path needs a second human, which is
// stronger. This one has nobody, so it gets ten one-time codes instead.
//
// The card is hidden for everyone else: the server refuses them anyway, and
// showing a control that always fails is worse than not showing it.

/** Loads the remaining count and reveals the card, for the super_admin only. */
export async function loadRecoveryCodesCard(): Promise<void> {
  const card = byId('recovery-codes-card');
  const statusEl = byId('recovery-codes-status');
  if (!card || !statusEl) return;

  try {
    const res = await adminAccounts('backup-codes-status');
    if (!res || !res.ok) {
      // `forbidden` is the normal answer for every role but one. Leave the card
      // hidden rather than showing an error nobody can act on.
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const remaining = Number(res.remaining ?? 0);
    const total = Number(res.total ?? 10);
    const tone = remaining === 0 ? 'error' : (remaining <= 2 ? 'warning' : 'success');
    statusEl.className = '';
    statusEl.innerHTML =
      '<div class="gm-row" style="gap:.6rem; align-items:center;">' +
        '<span class="gm-badge gm-badge-' + tone + '">' + remaining + ' / ' + total + '</span>' +
        '<span style="color: var(--text-muted); font-size: var(--fs-sm);">' +
          (remaining === 0
            ? 'No codes left. Issue a new set now.'
            : remaining <= 2
              ? 'Running low. Issue a new set soon.'
              : 'unused codes remaining.') +
        '</span>' +
      '</div>';
  } catch (_) {
    card.classList.add('hidden');
  }
}

/** Issues a fresh set of ten, shown once. */
async function regenerateRecoveryCodes(): Promise<void> {
  const btn = byId<HTMLButtonElement>('recovery-codes-regen-btn');
  const out = byId('recovery-codes-output');
  if (!out) return;

  // Reissuing invalidates the previous set, so a code written down last year
  // stops working. Say that before doing it, not after.
  const ok = typeof window !== 'undefined'
    ? window.confirm('Issue ten new recovery codes?\n\nYour current codes stop working immediately. The new ones are shown once and never again.')
    : false;
  if (!ok) return;

  if (btn) btn.disabled = true;
  try {
    const res = await adminAccounts('backup-codes-regenerate');
    if (!res || !res.ok || !Array.isArray(res.codes)) {
      showToast('Could not issue new codes.', 'error');
      return;
    }
    const codes: string[] = res.codes;
    out.classList.remove('hidden');
    out.innerHTML =
      '<div class="terms-callout warning" style="margin-bottom:.75rem; font-size: var(--fs-sm); line-height:1.45;">' +
        '<i class="ph ph-warning"></i> Save these now. They are shown once and cannot be recovered.' +
      '</div>' +
      '<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap:.4rem;">' +
        codes.map((c) => '<code class="gm-code-chip" style="padding:.45rem .6rem; border-radius:8px; background: var(--bg-2, #1a1b1e); font-family: var(--font-mono, monospace);">' + esc(c) + '</code>').join('') +
      '</div>' +
      '<div class="gm-row" style="gap:.5rem; margin-top:.75rem;">' +
        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm" id="recovery-codes-copy"><i class="ph ph-copy"></i> Copy all</button>' +
        '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm" id="recovery-codes-download"><i class="ph ph-download-simple"></i> Download</button>' +
      '</div>';

    const copyBtn = byId('recovery-codes-copy');
    if (copyBtn) copyBtn.addEventListener('click', () => {
      if (navigator.clipboard) {
        void navigator.clipboard.writeText(codes.join('\n'))
          .then(() => showToast('Recovery codes copied.', 'success'))
          .catch(() => showToast('Could not copy. Select them by hand.', 'error'));
      }
    });
    const dlBtn = byId('recovery-codes-download');
    if (dlBtn) dlBtn.addEventListener('click', () => {
      const blob = new Blob(
        ['FGF Guild Management recovery codes\nIssued ' + new Date().toISOString() + '\n\n' + codes.join('\n') + '\n'],
        { type: 'text/plain' }
      );
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'fgf-recovery-codes.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    showToast('Ten new recovery codes issued.', 'success');
    void loadRecoveryCodesCard();
  } catch (err: any) {
    showToast('Could not issue new codes: ' + (err && err.message ? err.message : 'unknown error'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Wires the reissue button once. */
export function wireRecoveryCodesCard(): void {
  const btn = byId('recovery-codes-regen-btn');
  if (!btn || (btn as any).__gmRecoveryWired) return;
  (btn as any).__gmRecoveryWired = true;
  btn.addEventListener('click', () => { void regenerateRecoveryCodes(); });
}

// Passkeys were removed entirely on 2026-10-03 (owner decision): the "My
// Passkeys" card went on 2026-09-27, and the sign-in path, the admin reset and
// the server function followed. Recovery codes above are part of the Discord
// flow and stay.
