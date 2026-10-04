/**
 * tests/app_auth_bootstrap.test.js
 *
 * Sous-lot 6.3 — unit suite for the typed auth/session/version/portal modules
 * ported from app.js into src/modules/app/auth/. Legacy app.js is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Phase 7: `revealPortal` imports the portal view instead of probing the
// GM_PORTAL global, so the stub these tests used no longer intercepts it.
vi.mock('../src/modules/portal/views/PortalView', () => ({
  portalView: { loadDashboard: vi.fn(), renderDashboard: vi.fn() }
}));
import { portalView } from '../src/modules/portal/views/PortalView';

// Phase M4c: the controller imports its collaborators instead of reading them
// off the window bridge, so the stubs are module mocks now. The DB stub
// goes through setDbClient(), the way main.ts installs the real client.
const mocks = vi.hoisted(() => ({
  sessionInfo: vi.fn(),
  forceRefreshPortalSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  ensureGuildRestriction: vi.fn(),
  showAdminDashboard: vi.fn(),
  reloadActiveView: vi.fn(),
  fetchGuilds: vi.fn()
}));
vi.mock('../src/core/api/supabase', async (importOriginal) => ({
  ...(await importOriginal()),
  sessionInfo: mocks.sessionInfo,
  forceRefreshPortalSession: mocks.forceRefreshPortalSession
}));
vi.mock('../src/core/auth/session', async (importOriginal) => ({
  ...(await importOriginal()),
  login: mocks.login,
  logout: mocks.logout
}));
vi.mock('../src/core/auth/roles', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureGuildRestriction: mocks.ensureGuildRestriction
}));
vi.mock('../src/modules/app/router', async (importOriginal) => ({
  ...(await importOriginal()),
  showAdminDashboard: mocks.showAdminDashboard,
  reloadActiveView: mocks.reloadActiveView
}));
vi.mock('../src/modules/app/admin/accounts.controller', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchGuilds: mocks.fetchGuilds
}));

import {
  restoreSession,
  handleSuccessfulLogin,
  doLogout,
  initAuthForms,
  revealAdmin,
  revealPortal
} from '../src/modules/app/auth/auth.controller';
import {
  checkForNewVersion,
  showNewVersionBanner,
  resetVersionCheck
} from '../src/modules/app/auth/version-check';
import { getAppState, patchAppState, resetAppState } from '../src/core/state/app-state';
import { APP_VERSION } from '../src/core/config/constants';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { currentAccountId, getVerifiedAccountId } from '../src/core/auth/roles';

const AUTH_DOM = `
  <div id="login-view">
    <form id="login-form">
      <input id="username" />
      <input id="password" />
      <button type="submit"><span id="login-submit-label">Sign in</span></button>
    </form>
    <div id="login-error" class="hidden"><i class="ph"></i><span></span></div>
    <button id="logout-btn"></button>
  </div>
  <div id="dashboard-view" class="hidden"></div>
  <div id="player-portal-view" class="hidden">
    <div class="gm-portal-container">
      <div id="portal-step-form" class="hidden"></div>
    </div>
  </div>
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
  mocks.fetchGuilds.mockReset().mockImplementation(async () => undefined);
  mocks.showAdminDashboard.mockReset();
  mocks.reloadActiveView.mockReset();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = AUTH_DOM;
  resetAppState();
  resetVersionCheck();

  mocks.sessionInfo.mockReset().mockImplementation(async () => null);
  mocks.forceRefreshPortalSession.mockReset().mockImplementation(async () => null);
  mocks.login.mockReset().mockImplementation(async () => ({ ok: false, error: 'invalid_credentials' }));
  mocks.logout.mockReset().mockImplementation(async () => undefined);
  mocks.ensureGuildRestriction.mockReset().mockImplementation(async () => null);
  setDbClient(stubDb({ guild: 'ALPHA' }));
  stubHooks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetVersionCheck();
  resetAppState();
  document.body.innerHTML = '';
  resetSupabaseClient();
  localStorage.clear();
  sessionStorage.clear();
});

describe('checkForNewVersion', () => {
  it('fetches version.json with cache: no-store and shows the banner on mismatch', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: 'V9.9.9' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await checkForNewVersion();

    expect(fetchMock).toHaveBeenCalledWith('/version.json', { cache: 'no-store' });
    const banner = document.getElementById('new-version-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('V9.9.9');
  });

  it('shows no banner when the running version matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: APP_VERSION }) })));

    await checkForNewVersion();

    expect(document.getElementById('new-version-banner')).toBeNull();
  });

  it('does not fetch twice once a banner is already shown', async () => {
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
    mocks.sessionInfo.mockImplementation(() => new Promise((r) => { resolveInfo = r; }));

    const pending = restoreSession();

    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(true);

    resolveInfo({ role: 'guild_admin', accountId: 'Alpha' });
    await pending;
  });

  it('restores a guild_admin session and syncs the store + localStorage', async () => {
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'Alpha');
    mocks.sessionInfo.mockImplementation(async () => ({ role: 'guild_admin', accountId: 'Alpha' }));
    setDbClient(stubDb({ guild: 'ALPHA' }));

    const res = await restoreSession();

    expect(res.restored).toBe(true);
    expect(res.role).toBe('guild_admin');
    expect(getAppState().currentGuildRestriction).toBe('ALPHA');
    expect(localStorage.getItem('gm_guild_restriction')).toBe('ALPHA');
    expect(localStorage.getItem('gm_role')).toBe('guild_admin');
    expect(mocks.showAdminDashboard).toHaveBeenCalled();
  });

  it('logs out when a stale local session no longer resolves', async () => {
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'Alpha');
    mocks.sessionInfo.mockImplementation(async () => null);
    mocks.forceRefreshPortalSession.mockImplementation(async () => null);

    const res = await restoreSession();

    expect(res.restored).toBe(false);
    expect(localStorage.getItem('gm_role')).toBeNull();
    expect(mocks.logout).toHaveBeenCalled();
    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(false);
  });

  it('restores a player-portal session straight into the portal', async () => {
    localStorage.setItem('gm_portal_session', '1');
    mocks.sessionInfo.mockImplementation(async () => ({ role: 'member', accountId: 'Player1' }));

    const res = await restoreSession();

    expect(res.restored).toBe(true);
    expect(res.portal).toBe(true);
    expect(localStorage.getItem('gm_role')).toBe('member');
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('restores a member session into the player portal even without pre-existing gm_portal_session', async () => {
    localStorage.setItem('gm_role', 'member');
    mocks.sessionInfo.mockImplementation(async () => ({ role: 'member', accountId: 'Player2' }));

    const res = await restoreSession();

    expect(res.restored).toBe(true);
    expect(res.portal).toBe(true);
    expect(res.role).toBe('member');
    expect(localStorage.getItem('gm_role')).toBe('member');
    expect(localStorage.getItem('gm_portal_session')).toBe('1');
    expect(mocks.showAdminDashboard).not.toHaveBeenCalled();
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(true);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('resolves a server_admin restriction from the accounts row', async () => {
    localStorage.setItem('gm_role', 'server_admin');
    mocks.sessionInfo.mockImplementation(async () => ({ role: 'server_admin', accountId: 'Serv' }));
    setDbClient(stubDb({ guild: 'ALPHA', server_number: 1234 }));

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
    expect(getVerifiedAccountId()).toBe('Player1');
    expect(currentAccountId()).toBe('Player1');
    expect(mocks.showAdminDashboard).not.toHaveBeenCalled();
    expect(document.getElementById('player-portal-view').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(true);
    expect(portalView.loadDashboard).toHaveBeenCalled();
  });

  it('syncs the guild restriction and routes to the admin shell', async () => {
    setDbClient(stubDb({ guild: 'ALPHA' }));

    await handleSuccessfulLogin({ ok: true, role: 'guild_admin', id: 'Alpha' }, 'Alpha');

    expect(getAppState().currentGuildRestriction).toBe('ALPHA');
    expect(getAppState().currentGuild).toBe('ALPHA');
    expect(localStorage.getItem('gm_role')).toBe('guild_admin');
    expect(localStorage.getItem('gm_user')).toBe('Alpha');
    expect(getVerifiedAccountId()).toBe('Alpha');
    expect(currentAccountId()).toBe('Alpha');
    expect(mocks.showAdminDashboard).toHaveBeenCalled();
  });

  it('sets the server restriction for a server_admin login', async () => {
    setDbClient(stubDb({ guild: 'ALPHA', server_number: '4321' }));

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
    expect(mocks.showAdminDashboard).not.toHaveBeenCalled();
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

    expect(mocks.logout).toHaveBeenCalled();
    expect(localStorage.getItem('gm_role')).toBeNull();
    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(getAppState().currentServerRestriction).toBeNull();
    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(false);
  });
});

describe('auth forms', () => {
  it('submits a valid login through login() and routes on success', async () => {
    mocks.login.mockImplementation(async () => ({ ok: true, role: 'guild_admin', id: 'Alpha' }));
    setDbClient(stubDb({ guild: 'ALPHA' }));
    initAuthForms();

    document.getElementById('username').value = 'Alpha';
    document.getElementById('password').value = 'secret';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mocks.showAdminDashboard).toHaveBeenCalled());

    expect(mocks.login).toHaveBeenCalledWith('Alpha', 'secret');
    expect(document.getElementById('login-error').classList.contains('hidden')).toBe(true);
  });

  it('shows the invalid-credentials error without routing', async () => {
    mocks.login.mockImplementation(async () => ({ ok: false, error: 'invalid_credentials' }));
    initAuthForms();

    document.getElementById('username').value = 'Alpha';
    document.getElementById('password').value = 'wrong';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('login-error').classList.contains('hidden')).toBe(false));

    expect(mocks.showAdminDashboard).not.toHaveBeenCalled();
    expect(document.getElementById('login-error').querySelector('span').textContent).toBeTruthy();
  });

});

