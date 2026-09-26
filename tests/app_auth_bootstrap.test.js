/**
 * tests/app_auth_bootstrap.test.js
 *
 * Sous-lot 6.3 — unit suite for the typed auth/session/version/portal modules
 * ported from app.js into src/modules/app/auth/. Legacy app.js is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Phase 7: `revealPortal` imports the portal view instead of probing
// `window.GM_PORTAL`, so the stub these tests used no longer intercepts it.
vi.mock('../src/modules/portal/views/PortalView', () => ({
  portalView: { loadDashboard: vi.fn(), renderDashboard: vi.fn() }
}));
import { portalView } from '../src/modules/portal/views/PortalView';

import {
  restoreSession,
  handleSuccessfulLogin,
  doLogout,
  showAuthTab,
  initAuthForms,
  revealAdmin,
  revealPortal
} from '../src/modules/app/auth/auth.controller';
import {
  checkForNewVersion,
  showNewVersionBanner,
  resetVersionCheck
} from '../src/modules/app/auth/version-check';
import { handlePortalLookupSuccess } from '../src/modules/app/auth/portal.controller';
import { getAppState, patchAppState, resetAppState } from '../src/core/state/app-state';

const AUTH_DOM = `
  <div id="login-view">
    <form id="login-form">
      <input id="username" />
      <input id="password" />
      <button type="submit"><span id="login-submit-label">Sign in</span></button>
    </form>
    <div id="login-error" class="hidden"><i class="ph"></i><span></span></div>
    <button id="go-to-register-btn"></button>
    <button id="auth-tab-signin"></button>
    <button id="auth-tab-register"></button>
    <button id="auth-tab-guild-request"></button>
    <button id="logout-btn"></button>
  </div>
  <form id="register-form" class="hidden">
    <input id="register-id" />
    <input id="register-password" />
    <input id="register-uid" />
    <input id="register-code" />
    <button type="submit"><span>Create account</span></button>
    <button id="register-back-btn" type="button"></button>
  </form>
  <div id="register-error" class="hidden"><i class="ph"></i><span></span></div>
  <form id="guild-request-form" class="hidden">
    <input id="guild-request-tag" />
    <input id="guild-request-server" />
    <input id="guild-request-admin-id" />
    <input id="guild-request-discord" />
    <textarea id="guild-request-note"></textarea>
    <button type="submit"><span>Request</span><span class="label">Submit</span></button>
    <button id="guild-request-back-btn" type="button"></button>
  </form>
  <div id="guild-request-error" class="hidden"><i class="ph"></i><span></span></div>
  <div id="guild-request-success" class="hidden"></div>
  <div id="dashboard-view" class="hidden"></div>
  <div id="player-portal-view" class="hidden">
    <div class="gm-portal-container">
      <div id="portal-step-lookup"></div>
      <div id="portal-step-form" class="hidden"></div>
    </div>
  </div>
  <div id="portal-lookup-error" class="hidden"><i class="ph"></i><span></span></div>
  <div id="toast-container"></div>
`;

function stubDb(account) {
  return {
    from() {
      const chain = {
        select() { return chain; },
        ilike() { return chain; },
        eq() { return chain; },
        maybeSingle: async () => ({ data: account, error: null })
      };
      return chain;
    }
  };
}

function stubHooks() {
  window.GM_APP = {
    fetchGuilds: vi.fn(async () => undefined),
    showAdminDashboard: vi.fn(),
    reloadActiveView: vi.fn()
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = AUTH_DOM;
  resetAppState();
  resetVersionCheck();

  window.GM = window.GM || {};
  window.GM.sessionInfo = vi.fn(async () => null);
  window.GM.forceRefreshPortalSession = vi.fn(async () => null);
  window.GM.login = vi.fn(async () => ({ ok: false, error: 'invalid_credentials' }));
  window.GM.logout = vi.fn(async () => undefined);
  window.GM.registerPlayer = vi.fn(async () => ({ ok: false, error: 'request_failed' }));
  window.GM.submitGuildRequest = vi.fn(async () => ({ ok: false, error: 'request_failed' }));
  window.GM.loginWithPasskey = vi.fn(async () => ({ ok: false, error: 'cancelled' }));
  window.GM.loginWithBackupCode = vi.fn(async () => ({ ok: false, error: 'invalid' }));
  window.GM.startConditionalPasskeyLogin = vi.fn(async () => null);
  window.GM.abortConditionalPasskeyLogin = vi.fn();
  window.GM.ensureGuildRestriction = vi.fn(async () => null);
  window.GM.db = stubDb({ guild: 'ALPHA' });
  stubHooks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetVersionCheck();
  resetAppState();
  document.body.innerHTML = '';
  delete window.GM_APP;
  delete window.GM_SHELL;
  localStorage.clear();
  sessionStorage.clear();
});

describe('checkForNewVersion', () => {
  it('fetches version.json with cache: no-store and shows the banner on mismatch', async () => {
    window.GM.appVersion = 'V1.0.0';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: 'V9.9.9' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await checkForNewVersion();

    expect(fetchMock).toHaveBeenCalledWith('/version.json', { cache: 'no-store' });
    const banner = document.getElementById('new-version-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('V9.9.9');
  });

  it('shows no banner when the running version matches', async () => {
    window.GM.appVersion = 'V9.9.9';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: 'V9.9.9' }) })));

    await checkForNewVersion();

    expect(document.getElementById('new-version-banner')).toBeNull();
  });

  it('does not fetch twice once a banner is already shown', async () => {
    window.GM.appVersion = 'V1.0.0';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: 'V2.0.0' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await checkForNewVersion();
    await checkForNewVersion();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('showNewVersionBanner wires Later to dismiss', () => {
    showNewVersionBanner('V2.0.0');
    expect(document.getElementById('new-version-banner')).toBeTruthy();
    expect(document.getElementById('new-version-refresh')).toBeTruthy();

    document.getElementById('new-version-later').click();
    expect(document.getElementById('new-version-banner')).toBeNull();
  });
});

describe('restoreSession', () => {
  it('hides the login panel before the async JWT check (anti-flash)', async () => {
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'Alpha');

    let resolveInfo;
    window.GM.sessionInfo = () => new Promise((r) => { resolveInfo = r; });

    const pending = restoreSession();

    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(true);

    resolveInfo({ role: 'guild_admin', accountId: 'Alpha' });
    await pending;
  });

  it('restores a guild_admin session and syncs the store + localStorage', async () => {
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'Alpha');
    window.GM.sessionInfo = vi.fn(async () => ({ role: 'guild_admin', accountId: 'Alpha' }));
    window.GM.db = stubDb({ guild: 'ALPHA' });

    const res = await restoreSession();

    expect(res.restored).toBe(true);
    expect(res.role).toBe('guild_admin');
    expect(getAppState().currentGuildRestriction).toBe('ALPHA');
    expect(localStorage.getItem('gm_guild_restriction')).toBe('ALPHA');
    expect(localStorage.getItem('gm_role')).toBe('guild_admin');
    expect(window.GM_APP.showAdminDashboard).toHaveBeenCalledWith('guild_admin');
  });

  it('logs out when a stale local session no longer resolves', async () => {
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'Alpha');
    window.GM.sessionInfo = vi.fn(async () => null);
    window.GM.forceRefreshPortalSession = vi.fn(async () => null);

    const res = await restoreSession();

    expect(res.restored).toBe(false);
    expect(localStorage.getItem('gm_role')).toBeNull();
    expect(window.GM.logout).toHaveBeenCalled();
    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(false);
  });

  it('restores a player-portal session straight into the portal', async () => {
    localStorage.setItem('gm_portal_session', '1');
    window.GM.sessionInfo = vi.fn(async () => ({ role: 'member', accountId: 'Player1' }));

    const res = await restoreSession();

    expect(res.restored).toBe(true);
    expect(res.portal).toBe(true);
    expect(localStorage.getItem('gm_role')).toBe('member');
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('restores a member session into the player portal even without pre-existing gm_portal_session', async () => {
    localStorage.setItem('gm_role', 'member');
    window.GM.sessionInfo = vi.fn(async () => ({ role: 'member', accountId: 'Player2' }));

    const res = await restoreSession();

    expect(res.restored).toBe(true);
    expect(res.portal).toBe(true);
    expect(res.role).toBe('member');
    expect(localStorage.getItem('gm_role')).toBe('member');
    expect(localStorage.getItem('gm_portal_session')).toBe('1');
    expect(window.GM_APP.showAdminDashboard).not.toHaveBeenCalled();
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(true);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('resolves a server_admin restriction from the accounts row', async () => {
    localStorage.setItem('gm_role', 'server_admin');
    window.GM.sessionInfo = vi.fn(async () => ({ role: 'server_admin', accountId: 'Serv' }));
    window.GM.db = stubDb({ guild: 'ALPHA', server_number: 1234 });

    await restoreSession();

    expect(getAppState().currentServerRestriction).toBe('1234');
    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(localStorage.getItem('gm_server_restriction')).toBe('1234');
  });
});

describe('handleSuccessfulLogin', () => {
  it('routes a member login directly to the player portal and sets portal session', async () => {

    await handleSuccessfulLogin({ ok: true, role: 'member', id: 'Player1' }, 'Player1');

    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(localStorage.getItem('gm_role')).toBe('member');
    expect(localStorage.getItem('gm_user')).toBe('Player1');
    expect(localStorage.getItem('gm_portal_session')).toBe('1');
    expect(window.GM.currentAccountId).toBe('Player1');
    expect(window.GM_APP.showAdminDashboard).not.toHaveBeenCalled();
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(true);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('syncs the guild restriction and routes to the admin shell', async () => {
    window.GM.db = stubDb({ guild: 'ALPHA' });

    await handleSuccessfulLogin({ ok: true, role: 'guild_admin', id: 'Alpha' }, 'Alpha');

    expect(getAppState().currentGuildRestriction).toBe('ALPHA');
    expect(getAppState().currentGuild).toBe('ALPHA');
    expect(localStorage.getItem('gm_role')).toBe('guild_admin');
    expect(localStorage.getItem('gm_user')).toBe('Alpha');
    expect(window.GM.currentAccountId).toBe('Alpha');
    expect(window.GM_APP.showAdminDashboard).toHaveBeenCalledWith('guild_admin');
  });

  it('sets the server restriction for a server_admin login', async () => {
    window.GM.db = stubDb({ guild: 'ALPHA', server_number: '4321' });

    await handleSuccessfulLogin({ ok: true, role: 'server_admin', id: 'Serv' }, 'Serv');

    expect(getAppState().currentServerRestriction).toBe('4321');
    expect(localStorage.getItem('gm_server_restriction')).toBe('4321');
  });

  it('clears all restrictions for a super_admin login', async () => {
    patchAppState({ currentGuildRestriction: 'ALPHA', currentServerRestriction: '1234' });

    await handleSuccessfulLogin({ ok: true, role: 'super_admin', id: 'HawkEye' }, 'HawkEye');

    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(getAppState().currentServerRestriction).toBeNull();
    expect(localStorage.getItem('gm_guild_restriction')).toBeNull();
  });
});

describe('revealAdmin and revealPortal', () => {
  it('guards revealAdmin against showing admin dashboard to members', () => {
    revealAdmin('member');
    expect(window.GM_APP.showAdminDashboard).not.toHaveBeenCalled();
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(true);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('revealPortal activates player portal and hides admin dashboard', () => {
    revealPortal();
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(true);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });
});

describe('doLogout', () => {
  it('clears storage, resets the store and shows the login screen', async () => {
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'Alpha');
    localStorage.setItem('gm_guild_restriction', 'ALPHA');
    patchAppState({ currentGuildRestriction: 'ALPHA', currentServerRestriction: '1234', currentGuild: 'ALPHA' });

    await doLogout();

    expect(window.GM.logout).toHaveBeenCalled();
    expect(localStorage.getItem('gm_role')).toBeNull();
    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(getAppState().currentServerRestriction).toBeNull();
    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(false);
  });
});

describe('showAuthTab', () => {
  it('toggles the three auth panels and maps legacy tab aliases', () => {
    showAuthTab('register');
    expect(document.getElementById('register-form').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('login-form').classList.contains('hidden')).toBe(true);

    showAuthTab('request');
    expect(document.getElementById('guild-request-form').classList.contains('hidden')).toBe(false);

    showAuthTab('login');
    expect(document.getElementById('login-form').classList.contains('hidden')).toBe(false);
  });
});

describe('auth forms', () => {
  it('submits a valid login through GM.login and routes on success', async () => {
    window.GM.login = vi.fn(async () => ({ ok: true, role: 'guild_admin', id: 'Alpha' }));
    window.GM.db = stubDb({ guild: 'ALPHA' });
    initAuthForms();

    document.getElementById('username').value = 'Alpha';
    document.getElementById('password').value = 'secret';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(window.GM_APP.showAdminDashboard).toHaveBeenCalled());

    expect(window.GM.login).toHaveBeenCalledWith('Alpha', 'secret');
    expect(document.getElementById('login-error').classList.contains('hidden')).toBe(true);
  });

  it('shows the invalid-credentials error without routing', async () => {
    window.GM.login = vi.fn(async () => ({ ok: false, error: 'invalid_credentials' }));
    initAuthForms();

    document.getElementById('username').value = 'Alpha';
    document.getElementById('password').value = 'wrong';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('login-error').classList.contains('hidden')).toBe(false));

    expect(window.GM_APP.showAdminDashboard).not.toHaveBeenCalled();
    expect(document.getElementById('login-error').querySelector('span').textContent).toBeTruthy();
  });

  it('resets the register form and reveals success feedback', async () => {
    window.GM.registerPlayer = vi.fn(async () => ({ ok: true }));
    initAuthForms();

    document.getElementById('register-id').value = 'newbie';
    document.getElementById('register-password').value = 'password1';
    document.getElementById('register-uid').value = '123456';
    document.getElementById('register-code').value = 'FGF-AAAA-BBBB';
    document.getElementById('register-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(window.GM.registerPlayer).toHaveBeenCalled());

    expect(window.GM.registerPlayer).toHaveBeenCalledWith('newbie', 'password1', '123456', 'FGF-AAAA-BBBB');
    expect(document.getElementById('register-id').value).toBe('');
    expect(document.getElementById('login-form').classList.contains('hidden')).toBe(false);
  });

  it('maps a guild-request validation error to a readable message', async () => {
    window.GM.submitGuildRequest = vi.fn(async () => ({ ok: false, error: 'invalid_server_number' }));
    initAuthForms();

    document.getElementById('guild-request-tag').value = 'NEW';
    document.getElementById('guild-request-server').value = '12';
    document.getElementById('guild-request-admin-id').value = 'admin';
    document.getElementById('guild-request-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('guild-request-error').classList.contains('hidden')).toBe(false));

    expect(document.getElementById('guild-request-error').querySelector('span').textContent)
      .toContain('exactly 4 digits');
  });
});

describe('handlePortalLookupSuccess', () => {
  it('reveals the portal dashboard when member-portal succeeds', async () => {
    window.GM.db = {
      functions: { invoke: vi.fn(async () => ({ data: { ok: true }, error: null })) }
    };

    await handlePortalLookupSuccess({ ok: true, id: 'Player1' }, 'Player1');

    expect(localStorage.getItem('gm_portal_session')).toBe('1');
    expect(document.getElementById('portal-step-form').classList.contains('hidden')).toBe(false);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('shows the connection error for a player_not_found response (legacy order parity)', async () => {
    window.GM.db = {
      functions: { invoke: vi.fn(async () => ({ data: { ok: false, error: 'player_not_found' }, error: null })) }
    };

    await handlePortalLookupSuccess({ ok: true, id: 'Player1' }, 'Player1');

    // app.js checks `!data.ok` before `data.error === 'player_not_found'`; the
    // live Edge returns ok:false for this case, so the generic branch wins.
    expect(document.getElementById('portal-lookup-error').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('portal-lookup-error').textContent).toContain('Unable to connect');
  });

  it('shows the unlinked-account message when the payload carries the error flag', async () => {
    window.GM.db = {
      functions: { invoke: vi.fn(async () => ({ data: { ok: true, error: 'player_not_found' }, error: null })) }
    };

    await handlePortalLookupSuccess({ ok: true, id: 'Player1' }, 'Player1');

    expect(document.getElementById('portal-lookup-error').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('portal-lookup-error').textContent).toContain('not linked');
  });
});
