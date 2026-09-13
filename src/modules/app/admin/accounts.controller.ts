/**
 * src/modules/app/admin/accounts.controller.ts
 *
 * Sous-lot 6.5 (Strangler) — admin accounts/guilds controller ported from
 * app.js: fetchAccounts/deleteAccount, fetchGuilds, populateAccountGuildSelect,
 * the create account/admin/guild forms, and wireJoinCode.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { t, esc, gm, winAny, byId, getDb, ls } from './utils';
import { setAccounts, filterAccountsOut, unshiftAccount, setPendingPassword, getAccounts } from './admin-store';
import { renderAccounts } from './accounts.render';
import { showToast } from '../dialogs/dialogs.service';

/** crypto.getRandomValues-based password generator (app.js#generatePassword). */
export function generatePassword(length: number): string {
  const chars = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ!@#$%';
  let result = '';
  const limit = 256 - (256 % chars.length);
  while (result.length < length) {
    const values = new Uint8Array(length * 2);
    crypto.getRandomValues(values);
    for (let i = 0; i < values.length && result.length < length; i++) {
      if (values[i] < limit) result += chars[values[i] % chars.length];
    }
  }
  return result;
}

export async function fetchAccounts(): Promise<void> {
  const g = gm();
  if (!g || !g.adminAccounts) return;
  try {
    const res = await g.adminAccounts('list');
    if (!res.ok) throw new Error(res.error || 'list_failed');
    setAccounts(res.accounts || []);
    renderAccounts();
  } catch (err: any) {
    showToast(t('toast_err_fetch_accounts') + ' ' + err.message, 'error');
  }
}

export async function deleteAccount(id: string): Promise<void> {
  try {
    const g = gm();
    const res = await g.adminAccounts('delete', { id });
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
  const w = winAny();
  try {
    const res = await db.from('guilds').select('id, subscription_type, subscription_end, server_number, payments_disabled').order('id');
    if (res.error) return;
    const data = res.data;
    if (data && data.length > 0) {
      w.guildsList = data.map((g: any) => g.id);
      w.guildsData = {};
      data.forEach((g: any) => {
        const sNum = g.server_number || (ls() ? ls()!.getItem('gm_server_number_' + g.id) : '') || '';
        w.guildsData[g.id] = {
          type: g.subscription_type || 'Unlimited',
          end: g.subscription_end || null,
          server_number: sNum,
          paymentsDisabled: !!g.payments_disabled
        };
      });
      if (w.GM_SHELL) {
        if (typeof w.GM_SHELL.renderTopbar === 'function') w.GM_SHELL.renderTopbar();
        if (typeof w.GM_SHELL.renderSidebar === 'function') w.GM_SHELL.renderSidebar();
      }
      populateAccountGuildSelect();
    }
  } catch (err) {
    console.error('Failed to fetch guilds list', err);
  }
}

export function populateAccountGuildSelect(): void {
  const w = winAny();
  const selectR4 = byId<HTMLSelectElement>('account-guild');
  if (selectR4) {
    const myGuild = w.currentGuildRestriction || w.currentGuild || 'ALPHA';
    selectR4.innerHTML = '<option value="' + esc(myGuild) + '">' + esc(myGuild) + '</option>';
    selectR4.value = myGuild;
    selectR4.disabled = true;
  }

  const selectR5 = byId<HTMLSelectElement>('superadmin-account-guild');
  if (selectR5) {
    let html = '';
    (w.guildsList || []).forEach((g: string) => {
      const sNum = (w.guildsData && w.guildsData[g] && w.guildsData[g].server_number) ? ' (#' + w.guildsData[g].server_number + ')' : '';
      html += '<option value="' + esc(g) + '">' + esc(g) + sNum + '</option>';
    });
    selectR5.innerHTML = html;
  }
}

function joinCodeStorageKey(): string {
  const w = winAny();
  const g = gm();
  const guild = w.currentGuild || (g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : null) || 'ALPHA';
  return 'gm_join_code_plain_' + guild;
}

/** Guild join-code card (permanent code, generated once, persisted server-side). */
export function wireJoinCode(): void {
  const copyBtn = byId<HTMLButtonElement>('join-code-copy-btn');
  const resultBox = byId('join-code-result');
  const resultVal = byId('join-code-value');
  const infoEl = byId('join-code-info');
  if (!resultVal) return;

  const g = gm();
  let currentCode = '';

  function showCode(code: string): void {
    currentCode = code || '';
    resultVal!.textContent = code || 'No code yet';
    if (resultBox) {
      if (code) {
        resultBox.classList.remove('gm-join-code-empty');
        if (copyBtn) copyBtn.classList.remove('hidden');
      } else {
        resultBox.classList.add('gm-join-code-empty');
        if (copyBtn) copyBtn.classList.add('hidden');
      }
    }
  }

  function setInfo(text: string): void {
    if (infoEl) infoEl.textContent = text;
  }

  async function loadJoinCode(): Promise<void> {
    const w = winAny();
    const guild = w.currentGuild || (g && typeof g.getActiveGuild === 'function' ? g.getActiveGuild() : null) || 'ALPHA';
    try {
      const res = await g.adminAccounts('get-join-code', { guild });
      if (!res.ok) throw new Error(res.error || 'get_code_failed');
      if (res.code) {
        showCode(res.code);
        setInfo("This is your guild's permanent join code. Share it with your players.");
      } else {
        const generatedCode = g.generateJoinCode('FGF');
        const setRes = await g.adminAccounts('set-join-code', { code: generatedCode, guild });
        if (!setRes.ok) throw new Error(setRes.error || 'set_code_failed');
        try { ls()?.setItem(joinCodeStorageKey(), generatedCode); } catch (_) { /* ignore */ }
        showCode(generatedCode);
        setInfo("This is your guild's permanent join code. Share it with your players.");
        showToast('Join code created.', 'success');
      }
    } catch (_err) {
      let storedCode = '';
      try { storedCode = ls()?.getItem(joinCodeStorageKey()) || ''; } catch (_) { /* ignore */ }
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

  const newPassword = generatePassword(12);
  try {
    const g = gm();
    const res = await g.adminAccounts('create', {
      id: identifier,
      password: newPassword,
      role: 'guild_admin',
      guild: (guildSelected === 'ALL' ? null : guildSelected),
      created_by: g.currentAccountId
    });
    if (!res.ok) throw new Error(res.error || 'create_failed');
    setPendingPassword(identifier, newPassword);
    unshiftAccount({
      id: identifier,
      role: 'guild_admin',
      guild: (guildSelected === 'ALL' ? null : guildSelected),
      created_at: new Date().toISOString()
    });
    renderAccounts();
    if (idInput) idInput.value = '';
    showToast(t('toast_account_created'), 'success');
  } catch (err: any) {
    showToast(err.message || t('toast_err_create'), 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = t('btn_generate');
  }
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

  const newPassword = generatePassword(12);
  try {
    const g = gm();
    const res = await g.adminAccounts('create', { id: identifier, password: newPassword, role: roleSelected, guild: guildSelected });
    if (!res.ok) throw new Error(res.error || 'create_failed');
    setPendingPassword(identifier, newPassword);
    unshiftAccount({ id: identifier, role: roleSelected, guild: guildSelected, created_at: new Date().toISOString() });
    renderAccounts();
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
  const w = winAny();
  const form = e.target as HTMLFormElement;
  const nameInput = byId<HTMLInputElement>('guild-name-input');
  const serverInput = byId<HTMLInputElement>('guild-server-input');
  const guildName = nameInput ? nameInput.value.trim().toUpperCase() : '';
  const serverNum = serverInput ? serverInput.value.trim() : '';
  if (!guildName) return;

  if (!/^\d{4}$/.test(serverNum)) { showToast('Server number must be exactly 4 digits (e.g. 1089).', 'error'); return; }
  if (/[^A-Z0-9_]/.test(guildName)) { showToast('Guild name must contain uppercase letters, numbers, or underscores.', 'error'); return; }
  if ((w.guildsList || []).indexOf(guildName) !== -1) { showToast('This guild already exists!', 'error'); return; }

  const btn = submitButton(form);
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span') : null;
  const origText = span ? span.textContent : '';
  if (span) span.textContent = 'Creating...';

  try {
    const db = getDb();
    const { error } = await db.from('guilds').insert({ id: guildName, server_number: serverNum });
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

// ── My Passkeys card (admin-home) ─────────────────────────────────────────────

let myPasskeysPanel: any = null;

/** Mounts the shared passkeys panel into the static accounts-tab card. */
export function mountMyPasskeysCard(): void {
  if (myPasskeysPanel) return;
  const x = gm();
  const wa = x && x.webauthn;
  if (!wa || typeof wa.mountPasskeysPanel !== 'function') return;
  myPasskeysPanel = wa.mountPasskeysPanel({
    listEl: byId('my-passkeys-list'),
    addBtnEl: byId('add-passkey-btn'),
    regenBtnEl: byId('regen-backup-codes-btn'),
    regenLabelEl: byId('backup-codes-btn-label')
  });
}

/** Mounts + refreshes the My Passkeys card (called on admin-home activation). */
export function loadMyPasskeysCard(): void {
  mountMyPasskeysCard();
  if (myPasskeysPanel && typeof myPasskeysPanel.reload === 'function') myPasskeysPanel.reload();
}
