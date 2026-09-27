/**
 * src/modules/app/auth/auth.controller.ts
 *
 * Sous-lot 6.3 (Strangler) — auth/session UI controller ported from app.js:
 * session restore, post-login routing, logout, the auth tab/form wiring, the
 * passkey nudge, passkey sign-in buttons and the backup-code dialog.
 *
 * Runtime notes:
 *  - `app.js` is still the authoritative parser-time wiring; this module is the
 *    typed replacement exposed on `window.GM_AUTH` (no auto-init yet, to avoid
 *    double listeners).
 *  - Restrictions are written through `patchAppState`, so `/src` modules and
 *    `app.js` stay coherent via the window mirror.
 *  - Passkey ceremonies delegate to `window.GM.webauthn` (via core/auth/session),
 *    and user feedback delegates to dialogs.service.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { escapeLike } from '../../../core/utils/text';
import { getAppState, patchAppState, resetAppState } from '../../../core/state/app-state';
import { showToast } from '../dialogs/dialogs.service';
import { setVerifiedRole } from '../../../core/auth/roles';
import { shellView } from '../../shell/views/ShellView';
import { portalView } from '../../portal/views/PortalView';

export type AuthTab = 'signin' | 'register' | 'guild-request' | 'login' | 'request';

export interface LoginResponse {
  ok: boolean;
  role?: string;
  id?: string;
  hasPasskey?: boolean;
  error?: string;
  [key: string]: any;
}

export type AuthSuccessHandler = (resp: LoginResponse, typedUser: string) => void | Promise<void>;

export interface RestoreSessionResult {
  restored: boolean;
  role?: string;
  portal?: boolean;
}

function w(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function ss(): Storage | null {
  return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id) as T | null;
}

function g(): any {
  return w().GM;
}

function db(): any {
  const x = g();
  return x && x.db ? x.db : null;
}

function normalizeRole(role: unknown): string {
  const x = g();
  if (x && typeof x.normalizeRole === 'function') return x.normalizeRole(role);
  if (role === 'R5' || role === 'admin' || role === 'super_admin') return 'super_admin';
  if (role === 'server_admin') return 'server_admin';
  if (role === 'R4' || role === 'guild_admin') return 'guild_admin';
  return 'member';
}

function t(key: string): string {
  const x = g();
  return x && typeof x.t === 'function' ? x.t(key) : key;
}

function setLoginError(message: string): void {
  const box = el('login-error');
  if (!box) return;
  const span = box.querySelector('span:last-of-type');
  if (span) span.textContent = message;
  box.classList.remove('hidden');
}

// ── UI reveal helpers ────────────────────────────────────────────────────────

export function revealPortal(): void {
  const loginView = el('login-view');
  const dashboardView = el('dashboard-view');
  const playerPortalView = el('player-portal-view');
  const portalStepLookup = el('portal-step-lookup');
  const portalStepForm = el('portal-step-form');

  if (loginView) loginView.classList.add('hidden');
  if (dashboardView) { dashboardView.classList.add('hidden'); dashboardView.classList.remove('active'); }
  if (playerPortalView) playerPortalView.classList.remove('hidden');
  if (portalStepLookup) portalStepLookup.classList.add('hidden');
  if (portalStepForm) portalStepForm.classList.remove('hidden');
  if (playerPortalView) playerPortalView.classList.add('portal-connected');

  const container = document.querySelector('.gm-portal-container');
  if (container) container.classList.add('portal-wide');

  void portalView.loadDashboard();
}

export function revealAdmin(role: string): void {
  if (role === 'member') {
    console.warn('Blocked attempt to reveal admin dashboard for member role. Redirecting to portal.');
    revealPortal();
    return;
  }
  const app = w().GM_APP;
  if (app && typeof app.showAdminDashboard === 'function') {
    app.showAdminDashboard(role);
    // The sidebar is rendered at boot, BEFORE sign-in resolves the tenant, and
    // this early return used to skip every re-render -- so the guild badge kept
    // whatever it showed at boot. That was invisible while an unresolved guild
    // silently read 'ALPHA' (finding H2): the badge displayed a plausible guild
    // name and nobody noticed it was the wrong one. Now that an unresolved
    // tenant says so out loud, the staleness is plain, so re-render here.
    shellView.renderSidebar();
    return;
  }
  const loginView = el('login-view');
  if (loginView) loginView.classList.add('hidden');
  const playerPortalView = el('player-portal-view');
  if (playerPortalView) { playerPortalView.classList.add('hidden'); playerPortalView.classList.remove('portal-connected'); }
  const dashboardView = el('dashboard-view');
  if (dashboardView) { dashboardView.classList.remove('hidden'); dashboardView.classList.add('active'); }
  shellView.renderShell();
}

function reloadActiveView(): void {
  const app = w().GM_APP;
  if (app && typeof app.reloadActiveView === 'function') app.reloadActiveView();
}

async function fetchGuildsIfAvailable(): Promise<void> {
  const app = w().GM_APP;
  if (app && typeof app.fetchGuilds === 'function') {
    try { await app.fetchGuilds(); } catch (_) { /* best effort */ }
  }
}

// ── Session restore ──────────────────────────────────────────────────────────

/**
 * Restores the persisted Supabase session on boot. Hides the login panel before
 * the async JWT verification (anti-flash of the admin dashboard), then either
 * restores the player portal, restores the admin dashboard, or logs out.
 */
export async function restoreSession(): Promise<RestoreSessionResult> {
  const store = ls();
  const localRole = store ? store.getItem('gm_role') : null;
  const localUser = store ? store.getItem('gm_user') : null;
  const portalSession = store ? store.getItem('gm_portal_session') === '1' : false;

  if (localRole || localUser) {
    const loginView = el('login-view');
    if (loginView) loginView.classList.add('hidden');
  }

  const x = g();
  let info: any = x && typeof x.sessionInfo === 'function' ? await x.sessionInfo() : null;
  if (!info && x && typeof x.forceRefreshPortalSession === 'function') {
    info = await x.forceRefreshPortalSession();
  }

  if (!info) {
    setVerifiedRole(null, null);
    if (localRole || localUser) await doLogout();
    return { restored: false };
  }

  // Player-portal session: restore the portal directly, full page.
  if (info.role === 'member') {
    setVerifiedRole('member', info.accountId);
    if (store) {
      store.setItem('gm_role', 'member');
      store.setItem('gm_portal_session', '1');
      if (info.accountId) store.setItem('gm_user', info.accountId);
      store.removeItem('gm_guild_restriction');
      store.removeItem('gm_server_restriction');
    }
    if (x && info.accountId) x.currentAccountId = info.accountId;
    patchAppState({ currentGuildRestriction: null, currentServerRestriction: null });
    revealPortal();
    return { restored: true, role: 'member', portal: true };
  }

  if (store) store.removeItem('gm_portal_session');

  // Restriction resolution (accounts-table-only).
  if (info.role === 'guild_admin' && info.accountId) {
    const client = db();
    let guild: string | null = null;
    if (client) {
      try {
        const { data } = await client.from('accounts').select('guild').ilike('id', escapeLike(info.accountId)).maybeSingle();
        guild = data && data.guild ? data.guild : null;
      } catch (err) {
        console.error('Failed to restore account guild restriction:', err);
      }
    }
    patchAppState({ currentGuildRestriction: guild, currentServerRestriction: null });
    if (store) {
      if (guild) { store.setItem('gm_guild_restriction', guild); store.setItem('gm_current_guild', guild); }
      else store.removeItem('gm_guild_restriction');
      store.removeItem('gm_server_restriction');
    }
  } else if (info.role === 'server_admin' && info.accountId) {
    const client = db();
    let serverNumber: string | null = null;
    if (client) {
      try {
        const { data } = await client.from('accounts').select('guild, server_number').ilike('id', escapeLike(info.accountId)).maybeSingle();
        const sNum = data && data.server_number;
        if (sNum) serverNumber = String(sNum);
        else if (data && data.guild) {
          const { data: guildRow } = await client.from('guilds').select('server_number').eq('id', data.guild).maybeSingle();
          if (guildRow && guildRow.server_number) serverNumber = String(guildRow.server_number);
        }
      } catch (err) {
        console.error('Failed to restore server restriction:', err);
      }
    }
    patchAppState({ currentGuildRestriction: null, currentServerRestriction: serverNumber });
    if (store) {
      if (serverNumber) store.setItem('gm_server_restriction', serverNumber);
      else store.removeItem('gm_server_restriction');
      store.removeItem('gm_guild_restriction');
    }
  } else {
    patchAppState({ currentGuildRestriction: null, currentServerRestriction: null });
    if (store) {
      store.removeItem('gm_guild_restriction');
      store.removeItem('gm_server_restriction');
    }
  }

  const role = info.role;
  setVerifiedRole(normalizeRole(role) as any, info.accountId);
  if (store) {
    store.setItem('gm_role', role);
    if (info.accountId) store.setItem('gm_user', info.accountId);
  }
  if (x && info.accountId) x.currentAccountId = info.accountId;

  if (role === 'guild_admin' && x && typeof x.ensureGuildRestriction === 'function') {
    try { await x.ensureGuildRestriction(); } catch (_) { /* best effort */ }
  }

  await fetchGuildsIfAvailable();
  // Same reason as at login: a reloaded tab whose stored selection was cleared
  // would otherwise restore into an empty Command Center.
  await ensureInitialGuildSelection(info.accountId || null);
  revealAdmin(role);
  reloadActiveView();

  return { restored: true, role };
}

// ── Post-login ───────────────────────────────────────────────────────────────

/** Shared post-login path (password, passkey, backup code). */
export async function handleSuccessfulLogin(resp: LoginResponse, typedUser?: string): Promise<void> {
  const x = g();
  if (x && typeof x.abortConditionalPasskeyLogin === 'function') x.abortConditionalPasskeyLogin();

  const canonicalUser = resp.id || typedUser || '';
  const loginError = el('login-error');
  if (loginError) loginError.classList.add('hidden');
  const password = el<HTMLInputElement>('password');
  if (password) password.value = '';

  await fetchGuildsIfAvailable();

  const role = normalizeRole(resp.role);
  const store = ls();
  setVerifiedRole(role as any, canonicalUser);

  if (role === 'member') {
    patchAppState({ currentGuildRestriction: null, currentServerRestriction: null });
    if (store) {
      store.setItem('gm_role', 'member');
      store.setItem('gm_user', canonicalUser);
      store.setItem('gm_portal_session', '1');
      store.removeItem('gm_guild_restriction');
      store.removeItem('gm_server_restriction');
    }
    if (x) x.currentAccountId = canonicalUser;

    revealPortal();
    showToast(t('toast_welcome') + ' ' + (typedUser || canonicalUser) + ' !', 'success');
    maybeShowSecureAccountPrompt(resp, role);
    return;
  }

  if (store) store.removeItem('gm_portal_session');

  if (role === 'guild_admin') {
    const client = db();
    let guild: string | null = null;
    if (client) {
      try {
        const { data } = await client.from('accounts').select('guild').ilike('id', escapeLike(canonicalUser)).maybeSingle();
        guild = data && data.guild ? data.guild : null;
      } catch (err) {
        console.error('Failed to load login guild restriction:', err);
      }
    }
    if (guild) {
      patchAppState({ currentGuildRestriction: guild, currentGuild: guild, currentServerRestriction: null });
      if (store) { store.setItem('gm_current_guild', guild); store.setItem('gm_guild_restriction', guild); store.removeItem('gm_server_restriction'); }
    } else {
      patchAppState({ currentGuildRestriction: null, currentServerRestriction: null });
      if (store) { store.removeItem('gm_guild_restriction'); store.removeItem('gm_server_restriction'); }
    }
  } else if (role === 'server_admin') {
    const client = db();
    let serverNumber: string | null = null;
    if (client) {
      try {
        const { data } = await client.from('accounts').select('guild, server_number').ilike('id', escapeLike(canonicalUser)).maybeSingle();
        const sNum = data && data.server_number;
        if (sNum) serverNumber = String(sNum);
        else if (data && data.guild) {
          const { data: guildRow } = await client.from('guilds').select('server_number').eq('id', data.guild).maybeSingle();
          if (guildRow && guildRow.server_number) serverNumber = String(guildRow.server_number);
        }
      } catch (err) {
        console.error('Failed to load login server restriction:', err);
      }
    }
    patchAppState({ currentGuildRestriction: null, currentServerRestriction: serverNumber });
    if (store) {
      if (serverNumber) store.setItem('gm_server_restriction', serverNumber);
      else store.removeItem('gm_server_restriction');
      store.removeItem('gm_guild_restriction');
    }
  } else {
    patchAppState({ currentGuildRestriction: null, currentServerRestriction: null });
    if (store) { store.removeItem('gm_guild_restriction'); store.removeItem('gm_server_restriction'); }
  }

  if (store) {
    store.setItem('gm_role', role);
    store.setItem('gm_user', canonicalUser);
  }
  if (x) x.currentAccountId = canonicalUser;

  // An admin who can see several tenants needs one selected, or every loader
  // bails and the Command Center renders empty (reported live, 2026-09-27).
  await ensureInitialGuildSelection(canonicalUser || null);

  revealAdmin(role);
  showToast(role === 'super_admin'
    ? t('toast_login_ok')
    : (t('toast_welcome') + ' ' + (typedUser || canonicalUser) + ' !'), 'success');

  maybeShowSecureAccountPrompt(resp, role);
}


/**
 * Picks a starting tenant for an admin who can see more than one.
 *
 * Finding H2 removed the `|| 'ALPHA'` fallback inside `getActiveGuild()`, which
 * was right: silently defaulting to a real tenant is how a super_admin writes
 * into the wrong guild. But nothing was put in its place for the admins who
 * legitimately see several, so after signing in `currentGuild` was null, every
 * tab loader bailed, and the Command Center came up EMPTY until you switched
 * tenant in the dropdown and switched back.
 *
 * This picks one explicitly instead. Never a hardcoded guild: the account's own
 * `guild` first, otherwise the first guild the switcher is showing. A
 * `guild_admin` never reaches here, because their branch has already set both
 * the restriction and the selection.
 */
async function ensureInitialGuildSelection(accountId: string | null): Promise<void> {
  if (getAppState().currentGuild) return;

  let guild: string | null = null;

  const client = db();
  if (client && accountId) {
    try {
      const { data } = await client
        .from('accounts').select('guild').ilike('id', escapeLike(accountId)).maybeSingle();
      if (data && data.guild) guild = String(data.guild);
    } catch (_) { /* fall through to the list */ }
  }

  if (!guild) {
    const list = getAppState().guildsList;
    if (Array.isArray(list) && list.length > 0) guild = String(list[0]);
  }

  // No guild visible at all: leave it unresolved rather than invent one. The
  // sidebar renders an explicit "no guild selected" state for exactly this.
  if (!guild) return;

  // The SELECTION only. Setting `currentGuildRestriction` here would remove the
  // tenant switcher, which renders on `isSuperAdmin && !restriction`.
  patchAppState({ currentGuild: guild });
  const store = ls();
  try { if (store) store.setItem('gm_current_guild', guild); } catch (_) { /* storage unavailable */ }
}

// ── Logout / login screens ───────────────────────────────────────────────────

export async function doLogout(): Promise<void> {
  setVerifiedRole(null, null);
  const x = g();
  if (x && typeof x.logout === 'function') {
    try {
      const r = x.logout();
      if (r && typeof r.then === 'function') await r;
    } catch (_) { /* ignore */ }
  }

  const store = ls();
  if (store) {
    ['gm_role', 'gm_user', 'gm_current_guild', 'gm_guild_restriction', 'gm_server_restriction', 'gm_portal_session']
      .forEach((k) => store.removeItem(k));
  }

  resetAppState();
  showLogin();
  showToast(t('toast_logout'), 'info');
}

export function showLogin(): void {
  const dashboardView = el('dashboard-view');
  if (dashboardView) { dashboardView.classList.add('hidden'); dashboardView.classList.remove('active'); }
  const loginView = el('login-view');
  if (loginView) { loginView.classList.remove('hidden'); loginView.classList.add('active'); }
  startConditionalPasskeyListener();
}

/** Arms the conditional/autofill passkey listener (silent, normal no-op). */
export function startConditionalPasskeyListener(): void {
  const x = g();
  if (!x || typeof x.startConditionalPasskeyLogin !== 'function') return;
  x.startConditionalPasskeyLogin()
    .then((resp: LoginResponse | null) => {
      if (resp && resp.ok) void handleSuccessfulLogin(resp, resp.id);
    })
    .catch(() => { /* silent by design */ });
}

// ── Discord sign-in ──────────────────────────────────────────────────────────

/**
 * Consumes a `?gm_auth=` ticket (or `?gm_auth_error=`) left by the
 * auth-discord callback redirect.
 *
 * MUST run before `restoreSession()`: it installs a session, and letting the
 * restore path win first would leave the ticket unspent in the URL while the
 * page settled into a logged-out state.
 *
 * The query parameters are stripped from the URL before anything else happens,
 * via `history.replaceState`. That matters for three reasons: a reload must not
 * retry an already-spent ticket, the ticket must not survive into a bookmark or
 * the browser's session history, and it must not leak through the `Referer` of
 * any subsequent request the page makes.
 *
 * Returns true when it handled the URL, so the caller can skip the ordinary
 * session restore.
 */
export async function handleDiscordCallback(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return false;
  }
  const ticket = params.get('gm_auth');
  const errorCode = params.get('gm_auth_error');
  if (!ticket && !errorCode) return false;

  // Strip first, act second.
  try {
    params.delete('gm_auth');
    params.delete('gm_auth_error');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
  } catch { /* replaceState is unavailable in some embedded webviews */ }

  if (errorCode) {
    setLoginError(discordErrorMessage(errorCode));
    return true;
  }

  const x = g();
  if (!x || typeof x.redeemDiscordTicket !== 'function') {
    setLoginError('Discord sign-in is unavailable in this build.');
    return true;
  }

  try {
    const resp: LoginResponse = await x.redeemDiscordTicket(ticket);
    if (resp.ok && resp.state === 'choose') {
      // One person, several accounts. Ask which, rather than picking for them:
      // an administrator who is also a player wants both, at different times.
      //
      // A `choose` with no ticket or no accounts is a server fault, not a state
      // to muddle through: falling past this branch would reach the generic
      // success path and try to build a session from a response with no tokens,
      // which surfaces as an unexplained "sign-in failed".
      if (resp.ticket && Array.isArray(resp.accounts) && resp.accounts.length > 0) {
        openAccountChooser(resp.ticket, resp.accounts, resp.discordUsername || null);
      } else {
        console.error('Discord sign-in returned "choose" without a usable ticket or account list:', resp);
        setLoginError('Discord sign-in could not list your accounts. Please try again, and tell HawkEye if it keeps happening.');
      }
      return true;
    }
    if (resp.ok && resp.state === 'unlinked') {
      // The Discord account is genuine, it simply is not attached yet. If an
      // admin issued a relink code (phase D6), this is where it is spent —
      // using the CONTINUATION ticket, so the code alone is not enough: the
      // person must also have just proved control of this Discord account.
      if (resp.ticket) {
        openLinkAccountDialog(resp.ticket, resp.discordUsername || null);
        return true;
      }
      const who = resp.discordUsername ? ' (' + resp.discordUsername + ')' : '';
      setLoginError('This Discord account' + who + ' is not linked to any account yet. Sign in with your identifier and password, then ask an admin for a relink code.');
      return true;
    }
    if (resp.ok) {
      await handleSuccessfulLogin(resp, resp.id || '');
      return true;
    }
    setLoginError(discordErrorMessage(resp.error || 'request_failed'));
  } catch (err: any) {
    console.error('Discord sign-in error:', err);
    setLoginError(discordErrorMessage('request_failed'));
  }
  return true;
}

/**
 * super_admin recovery, for when Discord itself is what broke.
 *
 * This is the one account with nobody above it. Every other account can be
 * unlinked by an administrator, who then issues a relink code; that path is
 * stronger because it needs a second human. The super_admin has no such
 * person, so they hold ten one-time codes instead.
 *
 * The server side (`auth-discord` action `backup-login`) and the client call
 * (`loginWithBackupCodeDiscord`) both already existed and were correct. What
 * was missing was any way to reach them: the login page's old "Use a backup
 * code instead" button called `openBackupCodeDialog()`, which is exported onto
 * the window.GM bridge and never invoked, so it did nothing when clicked. The
 * owner was holding ten valid codes he could not spend.
 */
export function openRecoveryCodeDialog(): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('recovery-code-overlay');
  if (existing) existing.remove();

  const html =
    '<div id="recovery-code-overlay" class="gm-modal-overlay">' +
      '<div class="gm-modal-card" style="max-width: 420px; width: 94%;">' +
        '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom:.6rem;">' +
          '<i class="ph ph-key" style="font-size: var(--fs-2xl); color: var(--md-sys-color-primary);"></i>' +
          '<h3 style="margin:0; font-size: var(--fs-xl);">Recovery code</h3>' +
        '</div>' +
        '<p style="margin:0 0 .8rem; color: var(--fg-dim); font-size: var(--fs-md); line-height:1.45;">' +
          'For the platform owner, when Discord sign-in is unavailable. Each code works once.' +
        '</p>' +
        '<div class="gm-login-field">' +
          '<label for="recovery-id">Identifier</label>' +
          '<input id="recovery-id" class="gm-input" type="text" autocomplete="username" autocapitalize="off" spellcheck="false">' +
        '</div>' +
        '<div class="gm-login-field" style="margin-top:.6rem;">' +
          '<label for="recovery-code">Recovery code</label>' +
          '<input id="recovery-code" class="gm-input" type="text" autocomplete="one-time-code" ' +
            'autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX">' +
        '</div>' +
        '<div id="recovery-error" class="gm-login-error hidden" style="margin-top:.6rem;">' +
          '<i class="ph ph-warning-circle"></i><span></span>' +
        '</div>' +
        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="recovery-cancel">Cancel</button>' +
          '<button type="button" class="gm-btn gm-btn-primary" id="recovery-submit">Sign in</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('recovery-code-overlay');
  if (!overlay) return;
  // Without this the dialog is invisible. See openAccountChooser: that exact
  // omission is what made Discord sign-in look broken for a day.
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const close = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 200);
  };
  const cancel = document.getElementById('recovery-cancel');
  if (cancel) cancel.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  const submit = document.getElementById('recovery-submit') as HTMLButtonElement | null;
  const idEl = document.getElementById('recovery-id') as HTMLInputElement | null;
  const codeEl = document.getElementById('recovery-code') as HTMLInputElement | null;
  if (idEl) idEl.focus();

  const fail = (msg: string): void => {
    const box = overlay.querySelector('#recovery-error') as HTMLElement | null;
    const span = box ? box.querySelector('span') : null;
    if (box && span) { span.textContent = msg; box.classList.remove('hidden'); }
    if (submit) submit.disabled = false;
  };

  const run = async (): Promise<void> => {
    const id = idEl ? idEl.value.trim() : '';
    const code = codeEl ? codeEl.value.trim() : '';
    if (!id || !code) { fail('Enter your identifier and a recovery code.'); return; }

    if (submit) submit.disabled = true;
    const x = g();
    if (!x || typeof x.loginWithBackupCodeDiscord !== 'function') {
      fail('Recovery is unavailable in this build.');
      return;
    }
    try {
      const resp: LoginResponse = await x.loginWithBackupCodeDiscord(id, code);
      if (resp.ok) {
        close();
        await handleSuccessfulLogin(resp, resp.id || id);
        const left = resp.backupCodesRemaining;
        if (typeof left === 'number') {
          showToast(
            left === 0
              ? 'That was your last recovery code. Issue a new set as soon as you can.'
              : left + ' recovery code' + (left === 1 ? '' : 's') + ' left.',
            left <= 2 ? 'warning' : 'info'
          );
        }
        return;
      }
      // `invalid_code` is deliberately the same answer for a wrong code, an
      // unknown account and an account that is not the super_admin: naming
      // which one would turn this into an account-enumeration oracle.
      fail(resp.error === 'account_locked'
        ? 'That account is temporarily locked. Try again later.'
        : resp.error === 'too_many_attempts'
          ? 'Too many attempts. Please wait a few minutes.'
          : 'That identifier and code did not match.');
    } catch (err) {
      console.error('Recovery sign-in failed:', err);
      fail('Something went wrong. Please try again.');
    }
  };

  if (submit) submit.addEventListener('click', () => { void run(); });
  if (codeEl) {
    codeEl.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') { ev.preventDefault(); void run(); }
    });
  }
}

interface DiscordAccountChoice { id: string; role: string; guild: string | null }

/**
 * Asks which account to sign in to, when a Discord identity holds several.
 *
 * The list comes from the server and only ever contains accounts linked to the
 * identity that just authenticated, so nothing here is a secret. Picking spends
 * the continuation ticket; the id is re-verified server-side.
 */
export function openAccountChooser(
  ticket: string,
  accounts: DiscordAccountChoice[],
  discordUsername: string | null
): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('discord-choose-overlay');
  if (existing) existing.remove();

  const who = discordUsername ? ' as <strong>' + escapeDialogText(discordUsername) + '</strong>' : '';

  // A super_admin or guild_admin lands on the Command Center, a member on the
  // Player Portal. Saying so removes the guessing.
  const describe = (a: DiscordAccountChoice): string => {
    if (a.role === 'super_admin') return 'Command Center, every guild';
    if (a.role === 'server_admin') return 'Command Center, your server';
    if (a.role === 'guild_admin') return 'Command Center' + (a.guild ? ', ' + escapeDialogText(a.guild) : '');
    return 'Player Portal' + (a.guild ? ', ' + escapeDialogText(a.guild) : '');
  };
  const iconFor = (a: DiscordAccountChoice): string =>
    a.role === 'member' ? 'ph-game-controller' : 'ph-shield-star';

  const row = (a: DiscordAccountChoice): string =>
    '<button type="button" class="gm-btn gm-btn-ghost gm-choose-account" data-account="' +
      escapeDialogText(a.id) + '" ' +
      'style="width:100%; justify-content:flex-start; gap:.6rem; padding:.7rem .75rem; margin-top:.4rem; text-align:left;">' +
      '<i class="ph ' + iconFor(a) + '" style="font-size: var(--fs-xl);"></i>' +
      '<span style="display:flex; flex-direction:column; gap:.1rem;">' +
        '<span style="font-weight:600;">' + escapeDialogText(a.id) + '</span>' +
        '<span style="font-size:.78rem; color: var(--fg-dim);">' + describe(a) + '</span>' +
      '</span>' +
    '</button>';

  const html =
    '<div id="discord-choose-overlay" class="gm-modal-overlay">' +
      '<div class="gm-modal-card" style="max-width: 430px; width: 94%;">' +
        '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom:.6rem;">' +
          '<i class="ph ph-discord-logo" style="font-size: var(--fs-2xl); color:#5865F2;"></i>' +
          '<h3 style="margin:0; font-size: var(--fs-xl);">Which account?</h3>' +
        '</div>' +
        '<p style="margin:0 0 .4rem; color: var(--fg-dim); font-size: var(--fs-md); line-height:1.45;">' +
          'You signed in' + who + '. This Discord account holds more than one account here.' +
        '</p>' +
        accounts.map(row).join('') +
        '<div id="discord-choose-error" class="gm-login-error hidden" style="margin-top:.6rem;"></div>' +
        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; margin-top:.9rem;">' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="discord-choose-cancel">Cancel</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  const host = document.createElement('div');
  host.innerHTML = html;
  const overlay = host.firstElementChild as HTMLElement | null;
  if (!overlay) return;
  document.body.appendChild(overlay);

  // `.gm-modal-overlay` is `opacity: 0` and only becomes visible with the
  // `visible` class. Without this line the dialog is in the DOM, fully wired,
  // and COMPLETELY INVISIBLE -- which is exactly what shipped: Discord sign-in
  // looked broken, nothing appeared, and the continuation ticket quietly
  // expired two minutes later. `openLinkAccountDialog` below does the same
  // thing correctly; this was not copied from it.
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const cancelBtn = overlay.querySelector('#discord-choose-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.remove(); }, 200);
    });
  }

  const fail = (msg: string): void => {
    const box = overlay.querySelector('#discord-choose-error') as HTMLElement | null;
    if (box) { box.textContent = msg; box.classList.remove('hidden'); }
    overlay.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = false; });
  };

  overlay.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.gm-choose-account') as HTMLElement | null;
    if (!btn) return;
    const accountId = btn.getAttribute('data-account') || '';
    if (!accountId) return;

    // The ticket is single-use: a second click would spend a ticket that is
    // already gone and fail with a confusing error.
    overlay.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = true; });

    const x = g();
    if (!x || typeof x.chooseDiscordAccount !== 'function') {
      fail('Account selection is unavailable in this build.');
      return;
    }
    void (async () => {
      try {
        const resp: LoginResponse = await x.chooseDiscordAccount(ticket, accountId);
        if (resp.ok) {
          overlay.remove();
          await handleSuccessfulLogin(resp, resp.id || accountId);
          return;
        }
        fail(resp.error === 'ticket_invalid'
          ? 'That took too long and the sign-in expired. Please click "Sign in with Discord" again.'
          : discordErrorMessage(resp.error || 'request_failed'));
      } catch (err) {
        console.error('Account selection failed:', err);
        fail(discordErrorMessage('request_failed'));
      }
    })();
  });
}

/**
 * Everything a Discord sign-in with no linked account can do next.
 *
 * Four paths, because four genuinely different people arrive here:
 *   claim  — an existing account holder proving their password (D3).
 *   code   — someone handed an invitation or relink code (D5 / D6).
 *   join   — a player joining a guild with its join code (D4).
 *   create — a leader starting a new guild (D4).
 *
 * All four spend the CONTINUATION ticket from the `unlinked` response, so no
 * secret is ever sufficient on its own: the person must also have just proved
 * control of the Discord account being attached.
 */
export function openLinkAccountDialog(ticket: string, discordUsername: string | null): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('discord-link-overlay');
  if (existing) existing.remove();

  type Path = 'claim' | 'code' | 'join' | 'create';
  const who = discordUsername ? ' as <strong>' + escapeDialogText(discordUsername) + '</strong>' : '';

  const option = (id: Path, icon: string, label: string): string =>
    '<button type="button" class="gm-btn gm-btn-ghost gm-link-path" data-path="' + id + '" ' +
      'style="flex:1 1 45%; justify-content:flex-start; gap:.45rem; font-size:.82rem; padding:.5rem .6rem;">' +
      '<i class="ph ' + icon + '"></i><span>' + label + '</span>' +
    '</button>';

  const field = (id: string, label: string, attrs: string): string =>
    '<div class="gm-login-field" style="margin-top:.6rem;">' +
      '<label for="' + id + '">' + label + '</label>' +
      '<input id="' + id + '" class="gm-input" ' + attrs + '>' +
    '</div>';

  const html =
    '<div id="discord-link-overlay" class="gm-modal-overlay">' +
      '<div class="gm-modal-card" style="max-width: 460px; width: 94%;">' +
        '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom:.6rem;">' +
          '<i class="ph ph-discord-logo" style="font-size: var(--fs-2xl); color:#5865F2;"></i>' +
          '<h3 style="margin:0; font-size: var(--fs-xl);">Welcome</h3>' +
        '</div>' +
        '<p style="margin:0 0 .8rem; color: var(--fg-dim); font-size: var(--fs-md); line-height:1.45;">' +
          'You signed in' + who + '. This Discord account is not linked yet — what would you like to do?' +
        '</p>' +
        '<div style="display:flex; flex-wrap:wrap; gap:.4rem;">' +
          option('claim', 'ph-user-check', 'I already have an account') +
          option('code', 'ph-ticket', 'I have a code') +
          option('join', 'ph-users-three', 'Join a guild') +
          option('create', 'ph-flag-banner', 'Create a guild') +
        '</div>' +

        '<div id="path-claim" class="gm-link-panel hidden">' +
          field('discord-link-id', 'Identifier', 'type="text" autocomplete="username"') +
          field('discord-link-password', 'Password', 'type="password" autocomplete="current-password"') +
          '<div class="terms-callout warning" style="margin-top:.7rem; font-size: var(--fs-sm); line-height:1.4;">' +
            '<i class="ph ph-warning"></i> After this, <strong>Discord becomes the only way in</strong> for this account. Your password and any passkeys are removed.' +
          '</div>' +
        '</div>' +

        '<div id="path-code" class="gm-link-panel hidden">' +
          field('discord-link-code', 'Invitation or relink code', 'type="text" placeholder="XXXXX-XXXXX" autocomplete="one-time-code"') +
          '<p style="margin:.5rem 0 0; color: var(--fg-dim); font-size: var(--fs-sm); line-height:1.4;">' +
            'An admin issues these — either to restore your access, or to add you as a new admin.' +
          '</p>' +
        '</div>' +

        '<div id="path-join" class="gm-link-panel hidden">' +
          field('discord-join-code', "Your guild's join code", 'type="text" autocomplete="off"') +
          field('discord-join-uid', 'Your in-game UID', 'type="text" inputmode="numeric" autocomplete="off"') +
          '<p style="margin:.5rem 0 0; color: var(--fg-dim); font-size: var(--fs-sm); line-height:1.4;">' +
            'Your UID must already be on the roster. An admin approves your account before you can sign in.' +
          '</p>' +
        '</div>' +

        '<div id="path-create" class="gm-link-panel hidden">' +
          field('discord-create-tag', 'Guild tag', 'type="text" maxlength="12" placeholder="SIGMA" autocomplete="off"') +
          field('discord-create-server', 'Server number', 'type="text" maxlength="4" inputmode="numeric" placeholder="1089" autocomplete="off"') +
          '<p style="margin:.5rem 0 0; color: var(--fg-dim); font-size: var(--fs-sm); line-height:1.4;">' +
            'You become its first admin. Two to twelve letters, digits or underscores; the tag must be free.' +
          '</p>' +
        '</div>' +

        '<div id="discord-link-error" class="gm-login-error hidden" style="margin-top:.6rem;">' +
          '<i class="ph ph-warning-circle"></i><span></span>' +
        '</div>' +
        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="discord-link-cancel">Cancel</button>' +
          '<button type="button" class="gm-btn gm-btn-primary" id="discord-link-submit" disabled>Continue</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('discord-link-overlay');
  if (!overlay) return;
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const closeModal = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 200);
  };
  const cancelBtn = document.getElementById('discord-link-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });

  const submitBtn = document.getElementById('discord-link-submit') as HTMLButtonElement | null;
  const setErr = (msg: string): void => {
    const errorEl = document.getElementById('discord-link-error');
    if (!errorEl) return;
    const span = errorEl.querySelector('span:last-of-type');
    if (span) span.textContent = msg;
    errorEl.classList.remove('hidden');
  };

  let path: Path | null = null;
  const LABELS: Record<Path, string> = {
    claim: 'Link and sign in',
    code: 'Redeem code',
    join: 'Request access',
    create: 'Create guild',
  };
  overlay.querySelectorAll('.gm-link-path').forEach((btn) => {
    btn.addEventListener('click', () => {
      path = btn.getAttribute('data-path') as Path;
      overlay.querySelectorAll('.gm-link-path').forEach((b) => b.classList.toggle('gm-active', b === btn));
      overlay.querySelectorAll('.gm-link-panel').forEach((pnl) => {
        pnl.classList.toggle('hidden', pnl.id !== 'path-' + path);
      });
      const errorEl = document.getElementById('discord-link-error');
      if (errorEl) errorEl.classList.add('hidden');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = LABELS[path];
      }
    });
  });

  const val = (id: string): string => ((el<HTMLInputElement>(id) || ({} as any)).value || '').trim();

  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      if (!path) return;
      const x = g();
      let resp: LoginResponse;

      submitBtn.disabled = true;
      try {
        if (path === 'claim') {
          const id = val('discord-link-id');
          const password = (el<HTMLInputElement>('discord-link-password') || ({} as any)).value || '';
          if (!id || !password) { setErr('Enter both your identifier and your password.'); return; }
          resp = x && typeof x.claimWithDiscord === 'function'
            ? await x.claimWithDiscord(ticket, id, password) : { ok: false, error: 'unavailable' };
        } else if (path === 'code') {
          const code = val('discord-link-code');
          if (!code) { setErr('Enter the code an admin gave you.'); return; }
          resp = x && typeof x.redeemLinkCode === 'function'
            ? await x.redeemLinkCode(ticket, code) : { ok: false, error: 'unavailable' };
        } else if (path === 'join') {
          const joinCode = val('discord-join-code');
          const uid = val('discord-join-uid');
          if (!joinCode || !uid) { setErr('Enter both the join code and your in-game UID.'); return; }
          resp = x && typeof x.onboardWithDiscord === 'function'
            ? await x.onboardWithDiscord(ticket, 'join', { join_code: joinCode, uid: uid })
            : { ok: false, error: 'unavailable' };
        } else {
          const tag = val('discord-create-tag');
          const server = val('discord-create-server');
          if (!tag || !server) { setErr('Enter both a guild tag and a server number.'); return; }
          resp = x && typeof x.onboardWithDiscord === 'function'
            ? await x.onboardWithDiscord(ticket, 'create', { guild_tag: tag, server_number: server })
            : { ok: false, error: 'unavailable' };
        }

        if (!resp.ok) {
          setErr(linkErrorMessage(resp.error || 'request_failed', path));
          return;
        }

        // A joined player has no session yet, by design: an admin approves
        // first. Say so rather than dropping them on a blank login screen.
        if (resp.state === 'pending_approval') {
          closeModal();
          setLoginError(
            'Your request to join ' + (resp.guild || 'the guild') +
            ' was submitted as ' + (resp.id || 'a new account') +
            '. An admin has to approve it — sign in with Discord again once they have.'
          );
          return;
        }

        closeModal();
        if (Array.isArray(resp.backupCodes) && resp.backupCodes.length) {
          showBackupCodesOnce(resp.backupCodes);
        }
        await handleSuccessfulLogin(resp, resp.id || '');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }
}

/** Maps a link/claim failure onto something the person can act on. */
function linkErrorMessage(code: string, path: 'claim' | 'code' | 'join' | 'create'): string {
  switch (code) {
    case 'discord_already_linked':
      return 'This Discord account is already linked to a different account.';
    case 'already_linked':
      return 'That account is already linked to a Discord account. Ask an admin to unlink it.';
    case 'ticket_invalid':
      return 'This attempt expired — each one is single-use. Close this and sign in with Discord again.';
    case 'account_not_active':
    case 'pending_approval':
      return 'That account is not active yet. Contact an admin.';
    case 'account_locked':
      return 'This account is temporarily locked after too many failed attempts.';
    case 'too_many_attempts':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'invalid_credentials':
      return 'Wrong identifier or password.';
    case 'request_timeout':
      return 'The server did not respond in time. Please check your connection and try again.';
    case 'invalid_code':
      return 'That join code is not valid.';
    case 'uid_not_in_guild':
      return 'That UID is not on the guild roster. Ask an admin to add you first.';
    case 'uid_already_claimed':
      return 'That UID is already attached to another account.';
    case 'invalid_uid':
      return 'A UID is digits only.';
    case 'invalid_guild_tag':
      return 'A guild tag is 2 to 12 letters, digits or underscores.';
    case 'invalid_server_number':
      return 'A server number is exactly four digits.';
    case 'tag_taken':
      return 'That guild tag is already taken.';
    case 'discord_account_too_new':
      return 'Your Discord account is too recent to create a guild. Ask an existing admin for an invitation instead.';
    case 'daily_limit_reached':
      return 'Too many guilds have been created today. Please try again tomorrow.';
    default:
      if (path === 'code') return 'That code is not valid, has expired, or was already used.';
      if (path === 'join') return 'Could not join that guild. Check the code and your UID.';
      if (path === 'create') return 'Could not create that guild. Please try again.';
      return 'Could not link this account. Please try again.';
  }
}

/**
 * Shows a freshly issued backup-code set once.
 *
 * Deliberately blocking and copy-to-clipboard: the server stores only hashes,
 * so there is no second chance to read these.
 */
function showBackupCodesOnce(codes: string[]): void {
  if (typeof document === 'undefined') return;
  const list = codes.map((c) => '<li style="font-family: var(--font-mono, monospace); font-size: var(--fs-md);">' + escapeDialogText(c) + '</li>').join('');
  const html =
    '<div id="backup-codes-once-overlay" class="gm-modal-overlay">' +
      '<div class="gm-modal-card" style="max-width: 420px; width: 92%;">' +
        '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom:.75rem;">' +
          '<i class="ph ph-key" style="font-size: var(--fs-2xl); color: var(--accent);"></i>' +
          '<h3 style="margin:0; font-size: var(--fs-xl);">Save your backup codes</h3>' +
        '</div>' +
        '<p style="margin:0 0 .8rem; color: var(--fg-dim); font-size: var(--fs-md); line-height:1.45;">' +
          'These are your only way back in if Discord becomes unavailable. They are <strong>shown once</strong> — store them somewhere safe now.' +
        '</p>' +
        '<ul style="margin:0; padding-left:1.2rem; line-height:1.9;">' + list + '</ul>' +
        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="backup-codes-once-copy">Copy</button>' +
          '<button type="button" class="gm-btn gm-btn-primary" id="backup-codes-once-done">I have saved them</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('backup-codes-once-overlay');
  if (!overlay) return;
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const copyBtn = document.getElementById('backup-codes-once-copy');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(codes.join('\n')).catch(() => undefined);
  });
  const doneBtn = document.getElementById('backup-codes-once-done');
  if (doneBtn) doneBtn.addEventListener('click', () => {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 200);
  });
}

/** Escaping for the single interpolation in the dialog above. */
function escapeDialogText(v: string): string {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** Maps an auth-discord error code to something a person can act on. */
function discordErrorMessage(code: string): string {
  switch (code) {
    case 'cancelled':
      return 'Discord sign-in was cancelled.';
    case 'state_invalid':
      return 'That Discord sign-in link has expired or was already used. Please try again.';
    case 'ticket_invalid':
      return 'That Discord sign-in has expired or was already used. Please try again.';
    case 'too_many_attempts':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'pending_approval':
      return 'Your account is awaiting approval by a guild admin.';
    case 'not_configured':
      return 'Discord sign-in is not configured on this deployment.';
    case 'exchange_failed':
    case 'identity_failed':
      return 'Discord did not confirm your identity. Please try again.';
    case 'request_timeout':
      return 'The server did not respond in time. Please check your connection and try again.';
    case 'server_error':
      return 'Something failed on the server during Discord sign-in. Please try again, and tell HawkEye if it keeps happening.';
    case 'account_not_linked':
      return 'That account is not linked to this Discord account.';
    case 'session_failed':
    case 'session_set_failed':
      return 'Your identity was confirmed but the session could not be opened. Please try again.';
    default:
      // The code is shown on purpose. "Discord sign-in failed. Please try
      // again." was the answer to every one of a dozen different causes, which
      // made a live report impossible to act on without reading server logs.
      return 'Discord sign-in failed (' + code + '). Please try again, and tell HawkEye if it keeps happening.';
  }
}

// ── Auth tabs & forms ────────────────────────────────────────────────────────

/** Switches between the signin / register / guild-request auth panels. */
export function showAuthTab(tab: AuthTab): void {
  const tabId = tab === 'login' ? 'signin' : (tab === 'request' ? 'guild-request' : tab);
  const loginForm = el('login-form');
  const registerForm = el('register-form');
  const guildRequestForm = el('guild-request-form');
  if (loginForm) loginForm.classList.toggle('hidden', tabId !== 'signin');
  if (registerForm) registerForm.classList.toggle('hidden', tabId !== 'register');
  if (guildRequestForm) guildRequestForm.classList.toggle('hidden', tabId !== 'guild-request');

  const registerError = el('register-error');
  if (registerError) registerError.classList.add('hidden');
  const guildRequestError = el('guild-request-error');
  if (guildRequestError) guildRequestError.classList.add('hidden');
  const guildRequestSuccess = el('guild-request-success');
  if (guildRequestSuccess) guildRequestSuccess.classList.add('hidden');

  const signinTab = el('auth-tab-signin');
  const registerTab = el('auth-tab-register');
  const requestTab = el('auth-tab-guild-request');
  if (signinTab) signinTab.classList.toggle('active', tabId === 'signin');
  if (registerTab) registerTab.classList.toggle('active', tabId === 'register');
  if (requestTab) requestTab.classList.toggle('active', tabId === 'guild-request');
}

/** Boolean-compatible wrapper kept for legacy call sites. */
export function showRegisterForm(show: boolean): void {
  showAuthTab(show ? 'register' : 'signin');
}

const GUILD_REQUEST_ERRORS: Record<string, string> = {
  invalid_guild_tag: 'Guild tag must be 2-12 letters, numbers or underscores.',
  invalid_server_number: 'Server number must be exactly 4 digits.',
  invalid_admin_id: 'Admin login must be 3 to 32 characters.',
  invalid_discord_handle: 'Please enter a valid Discord handle.',
  note_too_long: 'Note is too long (max 500 characters).',
  tag_taken: 'This guild tag is already taken or has a pending request.',
  admin_id_taken: 'This admin login is already taken or has a pending request.',
  too_many_pending_requests: 'Too many pending requests right now. Please try again later.',
  too_many_attempts: 'Too many attempts. Please wait a few minutes and try again.',
  missing_fields: 'Please fill in all required fields.',
  request_failed: 'Network error. Please try again.'
};

const REGISTER_ERRORS: Record<string, string> = {
  invalid_identifier: 'Identifier must be 3 to 32 characters.',
  weak_password: 'Password must be at least 8 characters.',
  invalid_uid: 'Invalid in-game UID.',
  invalid_code: 'Invalid guild join code.',
  uid_not_in_guild: 'This UID is not a member of the guild for this join code.',
  uid_already_claimed: 'This UID is already linked to an account.',
  identifier_taken: 'This identifier is already taken.',
  too_many_attempts: 'Too many attempts. Try again later.',
  request_failed: 'Network error. Please try again.'
};

async function onLoginSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const userInput = el<HTMLInputElement>('username');
  const passInput = el<HTMLInputElement>('password');
  const user = userInput ? userInput.value.trim() : '';
  const pass = passInput ? passInput.value : '';

  const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span') : null;
  if (span) span.textContent = t('login_btn_loading');

  try {
    const x = g();
    const resp: LoginResponse = x && typeof x.login === 'function'
      ? await x.login(user, pass)
      : { ok: false, error: 'no_client' };

    if (resp.ok) {
      await handleSuccessfulLogin(resp, user);
    } else if (resp.error === 'pending_approval') {
      setLoginError('Your account is awaiting approval by a guild admin.');
    } else if (resp.error === 'invalid_credentials') {
      setLoginError(t('login_error'));
    } else if (resp.error === 'too_many_attempts') {
      setLoginError('Too many attempts. Please wait a few minutes and try again.');
    } else if (resp.error === 'account_locked') {
      setLoginError('This account is temporarily locked after too many failed attempts.');
    } else if (resp.error === 'request_timeout') {
      setLoginError('The server did not respond in time. Please check your connection and try again.');
    } else {
      setLoginError(resp.error || t('login_error'));
    }
  } catch (err: any) {
    console.error('Login error details:', err);
    setLoginError(err && err.message ? err.message : t('login_error'));
    const card = document.querySelector('.login-card');
    if (card) {
      (card as HTMLElement).style.animation = 'none';
      void (card as HTMLElement).offsetHeight;
      (card as HTMLElement).style.animation = 'shake 0.4s ease-in-out';
    }
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = t('login_btn');
  }
}

async function onRegisterSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const id = (el<HTMLInputElement>('register-id') || ({} as any)).value || '';
  const pass = (el<HTMLInputElement>('register-password') || ({} as any)).value || '';
  const uid = (el<HTMLInputElement>('register-uid') || ({} as any)).value || '';
  const code = (el<HTMLInputElement>('register-code') || ({} as any)).value || '';

  const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span') : null;
  if (span) span.textContent = 'Submitting...';

  try {
    const x = g();
    const resp: LoginResponse = x && typeof x.registerPlayer === 'function'
      ? await x.registerPlayer(id.trim(), pass, uid.trim(), code.trim())
      : { ok: false, error: 'no_client' };

    if (resp.ok) {
      const registerError = el('register-error');
      if (registerError) registerError.classList.add('hidden');
      form.reset();
      showRegisterForm(false);
      showToast('Registration submitted. A guild admin will approve your account.', 'success');
    } else {
      const msg = REGISTER_ERRORS[resp.error || ''] || 'Registration failed. Please try again.';
      const registerError = el('register-error');
      if (registerError) {
        registerError.classList.remove('hidden');
        const regMsg = registerError.querySelector('span:last-of-type');
        if (regMsg) regMsg.textContent = msg;
      }
    }
  } catch (err) {
    console.error('Registration error details:', err);
    const registerError = el('register-error');
    if (registerError) registerError.classList.remove('hidden');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = 'Create account';
  }
}

async function onGuildRequestSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const tag = (el<HTMLInputElement>('guild-request-tag') || ({} as any)).value || '';
  const server = (el<HTMLInputElement>('guild-request-server') || ({} as any)).value || '';
  const adminId = (el<HTMLInputElement>('guild-request-admin-id') || ({} as any)).value || '';
  const discord = (el<HTMLInputElement>('guild-request-discord') || ({} as any)).value || '';
  const note = (el<HTMLTextAreaElement>('guild-request-note') || ({} as any)).value || '';

  const guildRequestError = el('guild-request-error');
  const guildRequestSuccess = el('guild-request-success');
  if (guildRequestError) guildRequestError.classList.add('hidden');
  if (guildRequestSuccess) guildRequestSuccess.classList.add('hidden');

  const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const span = btn ? btn.querySelector('span:last-of-type') : null;
  const origText = span ? span.textContent : '';
  if (span) span.textContent = 'Submitting...';

  try {
    const x = g();
    const resp: LoginResponse = x && typeof x.submitGuildRequest === 'function'
      ? await x.submitGuildRequest(tag.trim(), server.trim(), adminId.trim(), discord.trim(), note.trim())
      : { ok: false, error: 'no_client' };

    if (resp.ok) {
      form.reset();
      if (guildRequestSuccess) guildRequestSuccess.classList.remove('hidden');
    } else {
      const msg = GUILD_REQUEST_ERRORS[resp.error || ''] || 'Request failed. Please try again.';
      if (guildRequestError) {
        guildRequestError.classList.remove('hidden');
        const errMsg = guildRequestError.querySelector('span:last-of-type');
        if (errMsg) errMsg.textContent = msg;
      }
    }
  } catch (err) {
    console.error('Guild request error details:', err);
    if (guildRequestError) guildRequestError.classList.remove('hidden');
  } finally {
    if (btn) btn.disabled = false;
    if (span) span.textContent = origText;
  }
}

function wireOnce(node: HTMLElement | null, flag: string, event: string, handler: (e: Event) => void): void {
  if (!node || (node as any)[flag]) return;
  (node as any)[flag] = true;
  node.addEventListener(event, handler);
}

/** Wires the auth tabs/forms/logout. Idempotent via per-element flags. */
export function initAuthForms(): void {
  if (typeof document === 'undefined') return;

  wireOnce(el('login-form'), '__gmAuthWired', 'submit', (e) => { void onLoginSubmit(e); });
  wireOnce(el('register-form'), '__gmAuthWired', 'submit', (e) => { void onRegisterSubmit(e); });
  wireOnce(el('guild-request-form'), '__gmAuthWired', 'submit', (e) => { void onGuildRequestSubmit(e); });

  wireOnce(el('auth-tab-signin'), '__gmAuthWired', 'click', () => showAuthTab('signin'));
  wireOnce(el('auth-tab-register'), '__gmAuthWired', 'click', () => showAuthTab('register'));
  wireOnce(el('auth-tab-guild-request'), '__gmAuthWired', 'click', () => showAuthTab('guild-request'));
  wireOnce(el('go-to-register-btn'), '__gmAuthWired', 'click', () => showAuthTab('register'));
  wireOnce(el('register-back-btn'), '__gmAuthWired', 'click', () => showAuthTab('signin'));
  wireOnce(el('guild-request-back-btn'), '__gmAuthWired', 'click', () => showAuthTab('signin'));

  wireOnce(el('login-recovery-btn'), '__gmAuthWired', 'click', () => { openRecoveryCodeDialog(); });

  wireOnce(el('login-discord-btn'), '__gmAuthWired', 'click', () => {
    const x = g();
    if (x && typeof x.loginWithDiscord === 'function') x.loginWithDiscord();
  });

  wireOnce(el('logout-btn'), '__gmAuthWired', 'click', () => { void doLogout(); });
  wireOnce(el('member-logout-btn'), '__gmAuthWired', 'click', () => { void doLogout(); });
}

// ── Passkey nudge ────────────────────────────────────────────────────────────

/** One-time passkey nudge after a plain password login (never after a passkey). */
export function maybeShowSecureAccountPrompt(resp: LoginResponse, role: string): void {
  if (typeof document === 'undefined') return;
  if (resp.hasPasskey !== false) return;
  const storage = ss();
  if (storage && storage.getItem('gm_secure_prompt_dismissed') === '1') return;
  const x = g();
  if (!x || !x.webauthn || typeof x.webauthn.isSupported !== 'function' || !x.webauthn.isSupported()) return;

  const existing = document.getElementById('secure-account-banner');
  if (existing) existing.remove();

  const isPortal = role === 'member';

  const banner = document.createElement('div');
  banner.id = 'secure-account-banner';
  banner.style.cssText = 'position:fixed; bottom:1rem; right:1rem; z-index:9000; max-width:360px; ' +
    'background:var(--bg-soft, #1a1a24); border:1px solid rgba(255,255,255,0.1); border-radius:12px; ' +
    'padding:1rem 1.1rem; box-shadow:0 8px 24px rgba(0,0,0,0.4); display:flex; flex-direction:column; gap:.6rem;';
  banner.innerHTML =
    '<div style="display:flex; align-items:flex-start; gap:.6rem;">' +
      '<i class="ph ph-fingerprint" style="font-size: var(--fs-2xl); color:var(--accent); flex-shrink:0; margin-top:.1rem;"></i>' +
      '<div>' +
        '<div style="font-weight:600; margin-bottom:.15rem;">Secure your account</div>' +
        '<div style="font-size: var(--fs-sm); color:var(--fg-dim);">Add a passkey to sign in faster next time, without typing your password.</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex; gap:.5rem; justify-content:flex-end;">' +
      '<button type="button" id="secure-prompt-later" class="gm-btn gm-btn-ghost gm-btn-sm">Later</button>' +
      '<button type="button" id="secure-prompt-setup" class="gm-btn gm-btn-primary gm-btn-sm">Set up now</button>' +
    '</div>';

  document.body.appendChild(banner);

  function dismiss(): void {
    if (storage) storage.setItem('gm_secure_prompt_dismissed', '1');
    banner.remove();
  }

  const later = document.getElementById('secure-prompt-later');
  if (later) later.addEventListener('click', dismiss);
  const setup = document.getElementById('secure-prompt-setup');
  if (setup) setup.addEventListener('click', () => {
    dismiss();
    if (isPortal) {
      const navBtn = document.querySelector('[data-portal-nav="settings"]') as HTMLElement | null;
      if (navBtn) navBtn.click();
    } else {
      shellView.gotoItem('accounts');
    }
  });
}

// ── Passkey sign-in buttons / backup code dialog ─────────────────────────────

/** Wires a passkey sign-in button (id optional → fully discoverable ceremony). */
export function wirePasskeyLoginButton(
  btnId: string,
  idInputId: string,
  errorElId: string,
  onSuccess: AuthSuccessHandler
): void {
  const btn = el<HTMLButtonElement>(btnId);
  if (!btn) return;
  const x = g();
  if (x && x.webauthn && typeof x.webauthn.isSupported === 'function' && !x.webauthn.isSupported()) {
    btn.disabled = true;
    btn.title = 'Passkeys are not supported in this browser.';
  }

  btn.addEventListener('click', async () => {
    const idInput = el<HTMLInputElement>(idInputId);
    const id = idInput ? idInput.value.trim() : '';
    const errorEl = errorElId ? el(errorElId) : null;

    btn.disabled = true;
    const icon = btn.querySelector('i');
    const originalIconClass = icon ? icon.className : '';
    if (icon) icon.className = 'ph ph-circle-notch ph-spin';
    try {
      const client = g();
      const resp: LoginResponse = client && typeof client.loginWithPasskey === 'function'
        ? await client.loginWithPasskey(id)
        : { ok: false, error: 'webauthn_unavailable' };

      if (!resp.ok) {
        if (resp.error !== 'cancelled' && errorEl) {
          const msg = resp.error === 'no_passkeys'
            ? 'No passkey found for this account.'
            : resp.error === 'account_locked'
              ? 'This account is temporarily locked.'
              : 'Passkey sign-in failed.';
          const span = errorEl.querySelector('span:last-of-type');
          if (span) span.textContent = msg;
          errorEl.classList.remove('hidden');
        }
        return;
      }
      if (errorEl) errorEl.classList.add('hidden');
      await onSuccess(resp, id);
    } finally {
      btn.disabled = false;
      if (icon) icon.className = originalIconClass;
    }
  });
}

/** Backup-code sign-in dialog (both login screens). */
export function openBackupCodeDialog(idInputId: string, onSuccess: AuthSuccessHandler): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('backup-code-login-overlay');
  if (existing) existing.remove();

  const prefilledId = (el<HTMLInputElement>(idInputId) || ({} as any)).value || '';

  const html =
    '<div id="backup-code-login-overlay" class="gm-modal-overlay">' +
      '<div class="gm-modal-card" style="max-width: 380px; width: 92%;">' +
        '<div class="gm-modal-header" style="display:flex; align-items:center; gap:.5rem; margin-bottom: .75rem;">' +
          '<i class="ph ph-key" style="font-size: var(--fs-2xl); color: var(--accent);"></i>' +
          '<h3 style="margin:0; font-size: var(--fs-xl);">Use a Backup Code</h3>' +
        '</div>' +
        '<div class="gm-login-field">' +
          '<label for="backup-code-login-id">Identifier</label>' +
          '<input type="text" id="backup-code-login-id" class="gm-input" value="' + String(prefilledId).replace(/"/g, '&quot;') + '" autocomplete="username">' +
        '</div>' +
        '<div class="gm-login-field" style="margin-top:.6rem;">' +
          '<label for="backup-code-login-code">Backup code</label>' +
          '<input type="text" id="backup-code-login-code" class="gm-input" placeholder="XXXXX-XXXXX" autocomplete="one-time-code">' +
        '</div>' +
        '<div id="backup-code-login-error" class="gm-login-error hidden" style="margin-top:.6rem;">' +
          '<i class="ph ph-warning-circle"></i><span></span>' +
        '</div>' +
        '<div class="gm-modal-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="backup-code-login-cancel">Cancel</button>' +
          '<button type="button" class="gm-btn gm-btn-primary" id="backup-code-login-submit">Sign in</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('backup-code-login-overlay');
  if (!overlay) return;
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const closeModal = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); }, 200);
  };
  const cancelBtn = document.getElementById('backup-code-login-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });

  const submitBtn = document.getElementById('backup-code-login-submit') as HTMLButtonElement | null;
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const id = (el<HTMLInputElement>('backup-code-login-id') || ({} as any)).value || '';
      const code = (el<HTMLInputElement>('backup-code-login-code') || ({} as any)).value || '';
      const errorEl = document.getElementById('backup-code-login-error');
      const trimmedId = id.trim();
      const trimmedCode = code.trim();
      if (!trimmedId || !trimmedCode) {
        if (errorEl) {
          const span = errorEl.querySelector('span:last-of-type');
          if (span) span.textContent = 'Enter both your identifier and a backup code.';
          errorEl.classList.remove('hidden');
        }
        return;
      }

      submitBtn.disabled = true;
      try {
        const client = g();
        const resp: LoginResponse = client && typeof client.loginWithBackupCode === 'function'
          ? await client.loginWithBackupCode(trimmedId, trimmedCode)
          : { ok: false, error: 'webauthn_unavailable' };

        if (!resp.ok) {
          if (errorEl) {
            const span = errorEl.querySelector('span:last-of-type');
            if (span) {
              span.textContent = resp.error === 'account_locked'
                ? 'This account is temporarily locked.'
                : 'Invalid identifier or backup code.';
            }
            errorEl.classList.remove('hidden');
          }
          return;
        }
        closeModal();
        await onSuccess(resp, trimmedId);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }
}
