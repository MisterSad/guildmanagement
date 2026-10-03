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
import { clearPendingIntent, peekPendingIntent, savePendingIntent } from '../../../core/auth/pending-intent';

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
  // The password form is folded away by default; an error inside a closed
  // <details> would be invisible.
  const legacy = el<HTMLDetailsElement>('login-legacy');
  if (legacy) legacy.open = true;
}

type DiscordStatusTone = 'error' | 'info' | 'success';

/**
 * Shows a Discord sign-in outcome beside the Discord button. Every Discord
 * message goes here rather than into #login-error, which sits under the
 * password field of a form the person never touched.
 */
export function setDiscordStatus(message: string, tone: DiscordStatusTone = 'error'): void {
  const box = el('login-discord-status');
  if (!box) { setLoginError(message); return; }
  const span = box.querySelector('span:last-of-type');
  if (span) span.textContent = message;
  const icon = box.querySelector('i');
  if (icon) {
    icon.className = 'ph ' + (tone === 'error' ? 'ph-warning-circle' : tone === 'success' ? 'ph-check-circle' : 'ph-info');
  }
  box.classList.remove('gm-login-notice-error', 'gm-login-notice-info', 'gm-login-notice-success');
  box.classList.add('gm-login-notice-' + tone);
  box.classList.remove('hidden');
}

function clearDiscordStatus(): void {
  const box = el('login-discord-status');
  if (box) box.classList.add('hidden');
}

/**
 * Swaps the login card into a "Signing you in…" state while a returning
 * Discord ticket is redeemed, so the page does not sit there looking idle and
 * clickable for the second or two the round trip takes.
 */
function setLoginBusy(busy: boolean): void {
  const busyBox = el('login-busy');
  if (busyBox) busyBox.classList.toggle('hidden', !busy);
  for (const id of ['login-discord-btn', 'login-legacy']) {
    const node = el(id);
    if (node) node.classList.toggle('hidden', busy);
  }
  const hint = typeof document !== 'undefined' ? document.querySelector('.gm-login-discord-hint') : null;
  if (hint) hint.classList.toggle('hidden', busy);
}

/**
 * Boot-time follow-up for a shared invite link (`#join=` / `#code=`), once the
 * session restore has settled. Signed out: show the invitation banner, so the
 * person knows why they are here and what the button will do. Already signed
 * in: the link cannot apply to this session, so say so and drop it.
 */
export function applyLinkIntentAtBoot(alreadySignedIn: boolean): void {
  const intent = peekPendingIntent();
  if (!intent || !intent.fromLink) return;
  if (alreadySignedIn) {
    clearPendingIntent();
    showToast("You're already signed in. Sign out first to use this invitation link.", 'info');
    return;
  }
  const banner = el('login-invite-banner');
  if (!banner) return;
  const span = banner.querySelector('span');
  if (span) {
    span.textContent = intent.kind === 'join'
      ? "You've been invited to join a guild. Continue with Discord to accept — your join code is already filled in."
      : "You've received an invitation code. Continue with Discord to use it — it's already filled in.";
  }
  banner.classList.remove('hidden');
}

/** Per-device memory of the last sign-in route, so the right door is open. */
const LAST_METHOD_KEY = 'gm_last_signin_method';

function rememberSignInMethod(method: 'discord' | 'password'): void {
  try { const store = ls(); if (store) store.setItem(LAST_METHOD_KEY, method); } catch { /* storage blocked */ }
}

function lastSignInMethod(): string | null {
  try { const store = ls(); return store ? store.getItem(LAST_METHOD_KEY) : null; } catch { return null; }
}

/** Puts the Discord button back to its idle state. */
function resetDiscordButton(): void {
  const btn = el<HTMLButtonElement>('login-discord-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('is-loading');
  const span = btn.querySelector('span');
  if (span) span.textContent = t('login_btn_discord');
}

/** Starts the Discord redirect, with visible feedback while the page leaves. */
export function startDiscordSignIn(): void {
  const x = g();
  if (!x || typeof x.loginWithDiscord !== 'function') {
    setDiscordStatus('Discord sign-in is unavailable in this build.');
    return;
  }
  const btn = el<HTMLButtonElement>('login-discord-btn');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-loading');
    const span = btn.querySelector('span');
    if (span) span.textContent = 'Opening Discord…';
  }
  clearDiscordStatus();
  rememberSignInMethod('discord');
  x.loginWithDiscord();
}

// ── UI reveal helpers ────────────────────────────────────────────────────────

export function revealPortal(): void {
  const loginView = el('login-view');
  const dashboardView = el('dashboard-view');
  const playerPortalView = el('player-portal-view');
  const portalStepForm = el('portal-step-form');

  if (loginView) loginView.classList.add('hidden');
  if (dashboardView) { dashboardView.classList.add('hidden'); dashboardView.classList.remove('active'); }
  if (playerPortalView) playerPortalView.classList.remove('hidden');
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
  clearDiscordStatus();
  // An invite link someone followed while already holding an account was not
  // used -- say so, rather than let them think the invitation was accepted.
  // (The wizard clears the intent itself when it does spend the code.)
  const unusedLink = peekPendingIntent();
  if (unusedLink && unusedLink.fromLink) {
    showToast(
      unusedLink.kind === 'join'
        ? 'You already have an account, so the join link was not needed. You are signed in to it.'
        : 'You already have an account, so the invitation was not used. Ask the admin to issue it to an account without a Discord link.',
      'info'
    );
  }
  clearPendingIntent();
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

  // Land on Overview, explicitly.
  //
  // Reported live: after a Discord sign-in the app opened on Accounts & Access,
  // and that tab was EMPTY until you switched away and came back. One cause for
  // both. `handleDiscordCallback()` resolves true, so the boot path returns
  // before it reaches `restoreSavedTab()`, and nothing else activated a tab:
  // the page showed whichever panel carried `active` in the markup, and since
  // no tab activation had occurred, `triggerTabDataLoad` never ran for it.
  // Switching tabs ran the loader, which is why coming back looked fixed.
  //
  // `gotoItem` activates the panel AND calls `appOnTabActivated`, so the data
  // loads. A fresh sign-in starts on Overview; a reload still restores the last
  // tab through `restoreSession`, which is the behaviour worth keeping there.
  shellView.gotoItem('overview');

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
  const st = getAppState();
  if (st.currentGuild) {
    // A selection persisted in localStorage can name a guild that no longer
    // exists under that tag -- renamed (gm_rename_guild) or deleted since this
    // browser last chose it. Keep it only if the switcher still lists it; an
    // empty list means the guilds could not be loaded, which proves nothing.
    const list = Array.isArray(st.guildsList) ? st.guildsList : [];
    if (list.length === 0 || list.includes(st.currentGuild)) return;
    patchAppState({ currentGuild: null });
    try { ls()?.removeItem('gm_current_guild'); } catch (_) { /* storage unavailable */ }
  }

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
  // Signing out from the Player Portal must land somewhere: before this, the
  // portal stayed on screen and the person had to reload to see a login page.
  const portalView = el('player-portal-view');
  if (portalView) { portalView.classList.add('hidden'); portalView.classList.remove('portal-connected'); }
  setLoginBusy(false);
  resetDiscordButton();
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
    setDiscordStatus(discordErrorMessage(errorCode), errorCode === 'cancelled' ? 'info' : 'error');
    return true;
  }

  const x = g();
  if (!x || typeof x.redeemDiscordTicket !== 'function') {
    setDiscordStatus('Discord sign-in is unavailable in this build.');
    return true;
  }

  setLoginBusy(true);
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
        openAccountChooser(resp.ticket, resp.accounts, resp.discordUsername || null, resp.displayName || null);
      } else {
        console.error('Discord sign-in returned "choose" without a usable ticket or account list:', resp);
        setDiscordStatus('Discord sign-in could not list your accounts. Please try again, and tell HawkEye if it keeps happening.');
      }
      return true;
    }
    if (resp.ok && resp.state === 'unlinked') {
      // The Discord account is genuine, it simply is not attached yet. If an
      // admin issued a relink code (phase D6), this is where it is spent —
      // using the CONTINUATION ticket, so the code alone is not enough: the
      // person must also have just proved control of this Discord account.
      if (resp.ticket) {
        openLinkAccountDialog(resp.ticket, resp.discordUsername || null, resp.displayName || null);
        return true;
      }
      // The server now answers `server_error` rather than an unlinked state
      // with no ticket; this stays as a guard against an older deploy.
      setDiscordStatus('Something went wrong on our side. Please continue with Discord again.');
      return true;
    }
    if (resp.ok) {
      await handleSuccessfulLogin(resp, resp.id || '');
      return true;
    }
    if (resp.error === 'pending_approval') {
      showPendingScreen(null, null);
      return true;
    }
    setDiscordStatus(discordErrorMessage(resp.error || 'request_failed'));
  } catch (err: any) {
    console.error('Discord sign-in error:', err);
    setDiscordStatus(discordErrorMessage('request_failed'));
  } finally {
    // The success path has already swapped the view; on every other path the
    // login card must come back.
    setLoginBusy(false);
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
  discordUsername: string | null,
  displayName: string | null = null,
): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('discord-choose-overlay');
  if (existing) existing.remove();

  const who = discordUsername ? ' as <strong>' + escapeDialogText(discordUsername) + '</strong>' : '';
  const greeting = displayName ? 'Welcome back, ' + escapeDialogText(displayName) : 'Which account?';

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
          '<h3 style="margin:0; font-size: var(--fs-xl);">' + greeting + '</h3>' +
        '</div>' +
        '<p style="margin:0 0 .4rem; color: var(--fg-dim); font-size: var(--fs-md); line-height:1.45;">' +
          'You signed in' + who + '. This Discord account holds more than one account here — which one do you want to open?' +
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
      setDiscordStatus("Sign-in cancelled — continue with Discord whenever you're ready.", 'info');
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
          ? 'That took too long and the sign-in expired. Please press "Continue with Discord" again.'
          : discordErrorMessage(resp.error || 'request_failed'));
      } catch (err) {
        console.error('Account selection failed:', err);
        fail(discordErrorMessage('request_failed'));
      }
    })();
  });
}

/**
 * Everything a Discord sign-in with no linked account can do next, as a
 * two-step wizard: pick who you are, then fill one short form.
 *
 * Four paths, because four genuinely different people arrive here:
 *   join   — a player joining a guild with its join code (D4).
 *   claim  — an existing account holder proving their password (D3).
 *   code   — someone handed an invitation or relink code (D5 / D6).
 *   create — a leader starting a new guild (D4).
 * "I already have an account" holds both claim and code, as two tabs: the
 * person knows they already belong here, not which mechanism an admin used.
 *
 * Every path spends the CONTINUATION ticket from the `unlinked` response, so
 * no secret is ever sufficient on its own: the person must also have just
 * proved control of the Discord account being attached. A recoverable mistake
 * comes back with a fresh ticket (auth-discord, capped per authorization), so
 * the form stays filled in and the person simply corrects the field. When the
 * chain is spent, "Restart with Discord" carries the chosen path and the
 * non-secret fields across the round trip through the pending intent.
 */
export function openLinkAccountDialog(
  firstTicket: string,
  discordUsername: string | null,
  displayName: string | null = null,
): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('discord-link-overlay');
  if (existing) existing.remove();

  type Path = 'claim' | 'code' | 'join' | 'create';
  type Choice = 'join' | 'existing' | 'create';
  let ticket: string | null = firstTicket;

  const greetingName = displayName || discordUsername;
  const greeting = greetingName ? 'Welcome, ' + escapeDialogText(greetingName) : 'Welcome';
  const handle = discordUsername
    ? 'Signed in with Discord as <strong>@' + escapeDialogText(discordUsername) + '</strong>. '
    : 'Signed in with Discord. ';

  const card = (id: Choice, icon: string, title: string, body: string): string =>
    '<button type="button" class="gm-onboard-card" data-choice="' + id + '">' +
      '<i class="ph ' + icon + '" aria-hidden="true"></i>' +
      '<span class="gm-onboard-card-text">' +
        '<span class="gm-onboard-card-title">' + title + '</span>' +
        '<span class="gm-onboard-card-body">' + body + '</span>' +
      '</span>' +
      '<i class="ph ph-caret-right gm-onboard-card-caret" aria-hidden="true"></i>' +
    '</button>';

  const field = (id: string, label: string, attrs: string, help = ''): string =>
    '<div class="gm-login-field gm-onboard-field">' +
      '<label for="' + id + '">' + label + '</label>' +
      '<input id="' + id + '" class="gm-input" ' + attrs + ' aria-describedby="' + id + '-error' + (help ? ' ' + id + '-help' : '') + '">' +
      (help ? '<p id="' + id + '-help" class="gm-onboard-help">' + help + '</p>' : '') +
      '<p id="' + id + '-error" class="gm-onboard-field-error hidden" role="alert"></p>' +
    '</div>';

  const html =
    '<div id="discord-link-overlay" class="gm-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="discord-link-title">' +
      '<div class="gm-modal-card gm-onboard" style="max-width: 480px; width: 94%;">' +
        '<div class="gm-modal-header gm-onboard-header">' +
          '<button type="button" class="gm-onboard-back hidden" id="discord-link-back" aria-label="Back">' +
            '<i class="ph ph-arrow-left"></i>' +
          '</button>' +
          '<i class="ph ph-discord-logo gm-onboard-logo" aria-hidden="true"></i>' +
          '<h3 id="discord-link-title">' + greeting + '</h3>' +
        '</div>' +

        // ── Step 1: who are you? ──
        '<div id="discord-link-step-choose">' +
          '<p class="gm-onboard-lead">' + handle +
            'This Discord account isn\'t linked to anything here yet. What brings you here?</p>' +
          '<div class="gm-onboard-cards">' +
            card('join', 'ph-game-controller', "I'm a player — join my guild",
              "Use your guild's join code and your in-game UID. An officer approves you.") +
            card('existing', 'ph-user-check', 'I already have an account',
              'Sign in once with your identifier and password, or use a code an admin gave you.') +
            card('create', 'ph-flag-banner', 'I lead a guild — create it',
              'Set up a new guild space and become its first admin.') +
          '</div>' +
        '</div>' +

        // ── Step 2: the form for that choice ──
        '<div id="discord-link-step-form" class="hidden">' +
          '<div id="path-join" class="gm-link-panel hidden">' +
            '<h4 class="gm-onboard-panel-title">Join a guild</h4>' +
            field('discord-join-code', "Your guild's join code", 'type="text" autocomplete="off" spellcheck="false" placeholder="FGF-XXXX-XXXX"',
              'Ask an officer of your guild. It looks like FGF-XXXX-XXXX.') +
            field('discord-join-uid', 'Your in-game UID', 'type="text" inputmode="numeric" autocomplete="off" placeholder="Digits only"',
              'The number on your in-game profile. It must already be on your guild\'s roster.') +
            '<p class="gm-onboard-note"><i class="ph ph-info"></i> An officer approves new members. You\'ll get a Discord DM when it\'s done.</p>' +
          '</div>' +

          '<div id="path-existing" class="gm-link-panel hidden">' +
            '<h4 class="gm-onboard-panel-title">I already have an account</h4>' +
            '<div class="gm-onboard-tabs" role="tablist">' +
              '<button type="button" role="tab" class="gm-onboard-tab" data-tab="claim" aria-selected="true">Identifier &amp; password</button>' +
              '<button type="button" role="tab" class="gm-onboard-tab" data-tab="code" aria-selected="false">I have a code</button>' +
            '</div>' +
            '<div id="path-claim" class="gm-onboard-tabpanel">' +
              field('discord-link-id', 'Identifier', 'type="text" autocomplete="username"') +
              field('discord-link-password', 'Password', 'type="password" autocomplete="current-password"') +
              '<div class="terms-callout warning gm-onboard-warning">' +
                '<i class="ph ph-warning"></i> After this, <strong>Discord becomes the only way in</strong> for this account. Your password and any passkeys are removed.' +
              '</div>' +
            '</div>' +
            '<div id="path-code" class="gm-onboard-tabpanel hidden">' +
              field('discord-link-code', 'Invitation or relink code', 'type="text" placeholder="XXXXX-XXXXX" autocomplete="one-time-code" spellcheck="false"',
                'An admin issues these — to restore your access, or to add you as a new admin.') +
            '</div>' +
          '</div>' +

          '<div id="path-create" class="gm-link-panel hidden">' +
            '<h4 class="gm-onboard-panel-title">Create a guild</h4>' +
            field('discord-create-tag', 'Guild tag', 'type="text" maxlength="12" placeholder="SIGMA" autocomplete="off" spellcheck="false"',
              'Two to twelve letters, digits or underscores. It must be free.') +
            field('discord-create-server', 'Server number', 'type="text" maxlength="4" inputmode="numeric" placeholder="1089" autocomplete="off"',
              'The four-digit number of your game server.') +
            '<p class="gm-onboard-note"><i class="ph ph-info"></i> You become its first admin and land in the Command Center.</p>' +
          '</div>' +
        '</div>' +

        '<div id="discord-link-error" class="gm-login-error hidden" role="alert" style="margin-top:.8rem;">' +
          '<i class="ph ph-warning-circle"></i><span></span>' +
        '</div>' +
        '<div class="gm-modal-footer gm-onboard-footer">' +
          '<button type="button" class="gm-btn gm-btn-ghost" id="discord-link-cancel">Cancel</button>' +
          '<button type="button" class="gm-btn gm-btn-primary hidden" id="discord-link-restart">' +
            '<i class="ph ph-discord-logo"></i> Restart with Discord' +
          '</button>' +
          '<button type="button" class="gm-btn gm-btn-primary hidden" id="discord-link-submit">Continue</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = document.getElementById('discord-link-overlay');
  if (!overlay) return;
  requestAnimationFrame(() => { overlay.classList.add('visible'); });

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
  const submitBtn = $<HTMLButtonElement>('discord-link-submit');
  const restartBtn = $<HTMLButtonElement>('discord-link-restart');
  const cancelBtn = $<HTMLButtonElement>('discord-link-cancel');
  const backBtn = $<HTMLButtonElement>('discord-link-back');

  let path: Path | null = null;
  let busy = false;

  const LABELS: Record<Path, string> = {
    claim: 'Link and sign in',
    code: 'Redeem code',
    join: 'Request access',
    create: 'Create guild',
  };

  const val = (id: string): string => (($<HTMLInputElement>(id) || ({} as any)).value || '').trim();

  const clearErrors = (): void => {
    overlay.querySelectorAll('.gm-onboard-field-error').forEach((n) => { n.classList.add('hidden'); n.textContent = ''; });
    overlay.querySelectorAll('input[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    const box = $('discord-link-error');
    if (box) box.classList.add('hidden');
  };

  const setErr = (msg: string, fieldId?: string): void => {
    const fieldErr = fieldId ? $(fieldId + '-error') : null;
    if (fieldErr) {
      fieldErr.textContent = msg;
      fieldErr.classList.remove('hidden');
      const input = $<HTMLInputElement>(fieldId!);
      if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
      return;
    }
    const box = $('discord-link-error');
    if (!box) return;
    const span = box.querySelector('span:last-of-type');
    if (span) span.textContent = msg;
    box.classList.remove('hidden');
  };

  /** The ticket is gone: the only way forward is a fresh Discord authorization. */
  const offerRestart = (): void => {
    ticket = null;
    if (submitBtn) submitBtn.classList.add('hidden');
    if (restartBtn) restartBtn.classList.remove('hidden');
  };

  const isDirty = (): boolean =>
    Array.from(overlay.querySelectorAll('input')).some((n) => (n as HTMLInputElement).value.trim() !== '');

  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  const closeModal = (announce: boolean): void => {
    overlay.classList.remove('visible');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { overlay.remove(); }, 200);
    if (announce) setDiscordStatus("Sign-in cancelled — continue with Discord whenever you're ready.", 'info');
  };
  // Two clicks to discard what was typed, rather than a native confirm(): the
  // first click says what will happen, the second does it.
  const requestClose = (): void => {
    if (busy) return;
    if (!isDirty() || (cancelBtn && cancelBtn.dataset.confirm === '1')) { closeModal(true); return; }
    if (cancelBtn) {
      cancelBtn.dataset.confirm = '1';
      cancelBtn.textContent = 'Discard and close?';
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        cancelBtn.dataset.confirm = '';
        cancelBtn.textContent = 'Cancel';
      }, 4000);
    }
  };
  // The backdrop no longer closes this: a stray click used to throw away the
  // ticket and everything typed, silently.
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); requestClose(); } };
  document.addEventListener('keydown', onKey);
  if (cancelBtn) cancelBtn.addEventListener('click', requestClose);

  const setPath = (p: Path): void => {
    path = p;
    clearErrors();
    if (submitBtn && ticket) {
      submitBtn.textContent = LABELS[p];
      submitBtn.classList.remove('hidden');
    }
    overlay.querySelectorAll('.gm-onboard-tab').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.getAttribute('data-tab') === p));
    });
    const claimPanel = $('path-claim');
    const codePanel = $('path-code');
    if (claimPanel) claimPanel.classList.toggle('hidden', p !== 'claim');
    if (codePanel) codePanel.classList.toggle('hidden', p !== 'code');
  };

  const showStep = (c: Choice | null, initial?: Path): void => {
    const chooseStep = $('discord-link-step-choose');
    const formStep = $('discord-link-step-form');
    if (chooseStep) chooseStep.classList.toggle('hidden', c !== null);
    if (formStep) formStep.classList.toggle('hidden', c === null);
    if (backBtn) backBtn.classList.toggle('hidden', c === null);
    overlay.querySelectorAll('.gm-link-panel').forEach((pnl) => {
      pnl.classList.toggle('hidden', pnl.id !== 'path-' + c);
    });
    if (c === null) {
      path = null;
      clearErrors();
      if (submitBtn) submitBtn.classList.add('hidden');
      const first = overlay.querySelector('.gm-onboard-card') as HTMLElement | null;
      if (first) first.focus();
      return;
    }
    setPath(initial || (c === 'existing' ? 'claim' : c));
    const firstEmpty = Array.from(overlay.querySelectorAll('#path-' + c + ' input'))
      .find((n) => !(n as HTMLElement).closest('.hidden') && !(n as HTMLInputElement).value) as HTMLInputElement | undefined;
    if (firstEmpty) firstEmpty.focus();
  };

  overlay.querySelectorAll('.gm-onboard-card').forEach((btn) => {
    btn.addEventListener('click', () => { showStep(btn.getAttribute('data-choice') as Choice); });
  });
  overlay.querySelectorAll('.gm-onboard-tab').forEach((tab) => {
    tab.addEventListener('click', () => { setPath(tab.getAttribute('data-tab') as Path); });
  });
  if (backBtn) backBtn.addEventListener('click', () => { if (!busy) showStep(null); });

  // Pre-fill from what the person was doing before the last Discord round
  // trip: a restart, or (phase 4) a shared invite link.
  const intent = peekPendingIntent();
  if (intent) {
    const put = (id: string, v?: string): void => { const n = $<HTMLInputElement>(id); if (n && v) n.value = v; };
    put('discord-join-code', intent.kind === 'join' ? intent.code : undefined);
    put('discord-join-uid', intent.uid);
    put('discord-link-code', intent.kind === 'code' ? intent.code : undefined);
    put('discord-link-id', intent.accountId);
    put('discord-create-tag', intent.guildTag);
    put('discord-create-server', intent.serverNumber);
    if (intent.kind === 'join') showStep('join');
    else if (intent.kind === 'claim') showStep('existing', 'claim');
    else if (intent.kind === 'code') showStep('existing', 'code');
    else showStep('create');
  }

  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      // Carry the choice and the non-secret fields across the round trip. The
      // password is deliberately not among them.
      if (path) {
        savePendingIntent({
          kind: path,
          code: path === 'join' ? val('discord-join-code') : path === 'code' ? val('discord-link-code') : undefined,
          uid: val('discord-join-uid') || undefined,
          accountId: val('discord-link-id') || undefined,
          guildTag: val('discord-create-tag') || undefined,
          serverNumber: val('discord-create-server') || undefined,
        });
      }
      closeModal(false);
      startDiscordSignIn();
    });
  }

  // Which input a recoverable error belongs under.
  const FIELD_FOR: Record<string, string> = {
    invalid_code: 'discord-join-code',
    uid_not_in_guild: 'discord-join-uid',
    uid_already_claimed: 'discord-join-uid',
    invalid_uid: 'discord-join-uid',
    invalid_guild_tag: 'discord-create-tag',
    tag_taken: 'discord-create-tag',
    invalid_server_number: 'discord-create-server',
    invalid_credentials: 'discord-link-password',
    code_invalid: 'discord-link-code',
  };
  // Failures that happen before the ticket is spent, or where the network
  // may have dropped the request: the same ticket can still be tried.
  const TICKET_MAY_SURVIVE = new Set(['too_many_attempts', 'request_timeout', 'request_failed']);

  const submit = async (): Promise<void> => {
    if (!path || !ticket || busy) return;
    const x = g();
    let resp: LoginResponse;
    clearErrors();

    // Local checks first: an empty field must not spend an attempt.
    if (path === 'claim') {
      if (!val('discord-link-id')) { setErr('Enter your identifier.', 'discord-link-id'); return; }
      if (!(($<HTMLInputElement>('discord-link-password') || ({} as any)).value)) { setErr('Enter your password.', 'discord-link-password'); return; }
    } else if (path === 'code') {
      if (!val('discord-link-code')) { setErr('Enter the code an admin gave you.', 'discord-link-code'); return; }
    } else if (path === 'join') {
      if (!val('discord-join-code')) { setErr("Enter your guild's join code.", 'discord-join-code'); return; }
      if (!/^[0-9]{1,20}$/.test(val('discord-join-uid'))) { setErr('Enter your in-game UID — digits only.', 'discord-join-uid'); return; }
    } else {
      if (!/^[A-Za-z0-9_]{2,12}$/.test(val('discord-create-tag'))) { setErr('A guild tag is 2 to 12 letters, digits or underscores.', 'discord-create-tag'); return; }
      if (!/^[0-9]{4}$/.test(val('discord-create-server'))) { setErr('A server number is exactly four digits.', 'discord-create-server'); return; }
    }

    busy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.add('is-loading'); }
    try {
      if (path === 'claim') {
        const id = val('discord-link-id');
        const password = ($<HTMLInputElement>('discord-link-password') || ({} as any)).value || '';
        resp = x && typeof x.claimWithDiscord === 'function'
          ? await x.claimWithDiscord(ticket, id, password) : { ok: false, error: 'unavailable' };
      } else if (path === 'code') {
        const code = val('discord-link-code');
        resp = x && typeof x.redeemLinkCode === 'function'
          ? await x.redeemLinkCode(ticket, code) : { ok: false, error: 'unavailable' };
      } else if (path === 'join') {
        resp = x && typeof x.onboardWithDiscord === 'function'
          ? await x.onboardWithDiscord(ticket, 'join', { join_code: val('discord-join-code'), uid: val('discord-join-uid') })
          : { ok: false, error: 'unavailable' };
      } else {
        resp = x && typeof x.onboardWithDiscord === 'function'
          ? await x.onboardWithDiscord(ticket, 'create', {
            guild_tag: val('discord-create-tag').toUpperCase(),
            server_number: val('discord-create-server'),
          })
          : { ok: false, error: 'unavailable' };
      }

      if (!resp.ok) {
        const code = resp.error || 'request_failed';
        let msg = linkErrorMessage(code, path);
        if (resp.ticket) {
          // Recoverable: the server handed back a fresh ticket.
          ticket = resp.ticket;
          if (typeof resp.attemptsLeft === 'number' && resp.attemptsLeft <= 2) {
            msg += resp.attemptsLeft === 1 ? ' One attempt left.' : ' ' + resp.attemptsLeft + ' attempts left.';
          }
          setErr(msg, FIELD_FOR[code]);
          return;
        }
        if (TICKET_MAY_SURVIVE.has(code)) { setErr(msg); return; }
        setErr(code === 'ticket_invalid' || FIELD_FOR[code]
          ? msg + ' Restart with Discord to try again — what you typed is kept.'
          : msg);
        offerRestart();
        return;
      }

      clearPendingIntent();

      // A joined player has no session yet, by design: an admin approves
      // first. A screen of its own rather than an error-coloured line.
      if (resp.state === 'pending_approval') {
        closeModal(false);
        showPendingScreen(resp.guild || null, resp.id || null);
        return;
      }

      closeModal(false);
      if (Array.isArray(resp.backupCodes) && resp.backupCodes.length) {
        showBackupCodesOnce(resp.backupCodes);
      }
      await handleSuccessfulLogin(resp, resp.id || '');
    } finally {
      busy = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('is-loading'); }
    }
  };

  if (submitBtn) submitBtn.addEventListener('click', () => { void submit(); });
  overlay.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    if (ev.key === 'Enter' && target && target.tagName === 'INPUT') { ev.preventDefault(); void submit(); }
  });
}

/**
 * Swaps the login card to the "waiting for approval" screen. Shown after a
 * join request, and on any later sign-in while the account is still pending.
 */
export function showPendingScreen(guild: string | null, accountId: string | null): void {
  const box = el('login-pending');
  if (!box) {
    setDiscordStatus('Your request is waiting for approval by an officer of your guild.', 'info');
    return;
  }
  const text = el('login-pending-text');
  if (text) {
    text.textContent = guild
      ? 'Your request to join ' + guild + (accountId ? ' as ' + accountId : '') + ' was sent. It is waiting for one of its officers.'
      : 'Your request is waiting for an officer of your guild.';
  }
  clearDiscordStatus();
  setLoginBusy(false);
  for (const id of ['login-discord-btn', 'login-legacy', 'login-invite-banner']) {
    const node = el(id);
    if (node) node.classList.add('hidden');
  }
  const hint = document.querySelector('.gm-login-discord-hint');
  if (hint) hint.classList.add('hidden');
  box.classList.remove('hidden');
  const back = el<HTMLButtonElement>('login-pending-back');
  if (back) back.focus();
}

function hidePendingScreen(): void {
  const box = el('login-pending');
  if (box) box.classList.add('hidden');
  for (const id of ['login-discord-btn', 'login-legacy']) {
    const node = el(id);
    if (node) node.classList.remove('hidden');
  }
  const hint = document.querySelector('.gm-login-discord-hint');
  if (hint) hint.classList.remove('hidden');
  resetDiscordButton();
}

/** Maps a link/claim failure onto something the person can act on. */
function linkErrorMessage(code: string, path: 'claim' | 'code' | 'join' | 'create'): string {
  switch (code) {
    case 'discord_already_linked':
      return 'This Discord account is already linked to a different account.';
    case 'already_linked':
      return 'That account is already linked to a Discord account. Ask an admin to unlink it.';
    case 'ticket_invalid':
      return 'This sign-in expired.';
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

// ── Auth forms ───────────────────────────────────────────────────────────────

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
      rememberSignInMethod('password');
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

function wireOnce(node: HTMLElement | null, flag: string, event: string, handler: (e: Event) => void): void {
  if (!node || (node as any)[flag]) return;
  (node as any)[flag] = true;
  node.addEventListener(event, handler);
}

/** Wires the auth tabs/forms/logout. Idempotent via per-element flags. */
export function initAuthForms(): void {
  if (typeof document === 'undefined') return;

  wireOnce(el('login-form'), '__gmAuthWired', 'submit', (e) => { void onLoginSubmit(e); });

  // The segmented tab switcher, the "Register Player" form and the
  // "Request a Guild" form were removed from index.html, so showAuthTab(),
  // showRegisterForm(), onRegisterSubmit() and onGuildRequestSubmit() went
  // with them. There is one panel on the login screen now. A player joins
  // through Discord and a guild join code; a guild is requested on Discord.
  //
  // registerPlayer() and submitGuildRequest() stay in core/auth/session.ts:
  // their Edge Functions are still deployed, and client and function come
  // out together in phase D7.

  wireOnce(el('login-recovery-btn'), '__gmAuthWired', 'click', () => { openRecoveryCodeDialog(); });

  wireOnce(el('login-discord-btn'), '__gmAuthWired', 'click', () => { startDiscordSignIn(); });
  wireOnce(el('login-pending-back'), '__gmAuthWired', 'click', () => { hidePendingScreen(); });

  // Back from Discord's consent screen with the browser's Back button: the
  // page can come out of the bfcache with the button still saying "Opening
  // Discord…" and disabled.
  if (typeof window !== 'undefined' && !(window as any).__gmDiscordPageshowWired) {
    (window as any).__gmDiscordPageshowWired = true;
    window.addEventListener('pageshow', (e: PageTransitionEvent) => { if (e.persisted) resetDiscordButton(); });
  }

  // Open the password route for whoever used it last on this device; Discord
  // users never see it unfolded.
  const legacy = el<HTMLDetailsElement>('login-legacy');
  if (legacy && lastSignInMethod() === 'password') legacy.open = true;

  wireOnce(el('logout-btn'), '__gmAuthWired', 'click', () => { void doLogout(); });
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
