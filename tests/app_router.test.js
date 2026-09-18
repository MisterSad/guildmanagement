/**
 * tests/app_router.test.js
 *
 * Sous-lot 6.4/6.8 — unit suite for the tab router. After the final cutover the
 * router routes every tab directly to the typed /src controllers through the
 * window.GM_* bridges (no legacy app.js loader anymore).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  triggerTabDataLoad,
  onTabActivated,
  reloadActiveView,
  restoreSavedTab,
  initTabNavigation,
  showAdminDashboard,
  showLogin
} from '../src/modules/app/router';
import { getDomRefs, getDomRef } from '../src/modules/app/dom-refs';

const FIXTURE = `
  <div id="login-view"></div>
  <div id="dashboard-view">
    <div class="nav-tabs">
      <button class="nav-tab active" data-tab="admin-home" data-view="dashboard-view"></button>
      <button class="nav-tab" data-tab="admin-members" data-view="dashboard-view"></button>
      <button class="nav-tab" data-tab="event-svs" data-view="dashboard-view"></button>
      <button class="nav-tab" data-tab="gm-overview" data-view="dashboard-view"></button>
    </div>
    <div id="nav-container">
      <button class="nav-tab" data-tab="gm-overview" data-view="dashboard-view"></button>
      <button class="nav-tab" data-tab="admin-members" data-view="dashboard-view"></button>
    </div>
    <main class="dashboard-content tab-panel active" id="admin-home"></main>
    <main class="dashboard-content tab-panel" id="admin-members"></main>
    <main class="dashboard-content tab-panel" id="event-svs"></main>
    <main class="dashboard-content tab-panel" id="gm-overview"></main>
  </div>
  <div id="gm-anti-capture-fullscreen-overlay" class="hidden"></div>
`;

const tick = () => new Promise((r) => setTimeout(r, 0));

function stubBridge() {
  window.GM_MEMBERS = { fetchGuildMembers: vi.fn(), fetchBannedPlayers: vi.fn() };
  window.GM_ADMIN = {
    fetchAccounts: vi.fn(),
    loadGuildSettings: vi.fn(),
    populateAccountGuildSelect: vi.fn(),
    wireJoinCode: vi.fn(),
    fetchGuildRequests: vi.fn(),
    renderGuildsSubscriptionList: vi.fn(),
    renderMigrationGroupsList: vi.fn()
  };
}

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  localStorage.clear();
  stubBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
  delete window.GM_OVERVIEW;
  delete window.GM_EVENTS;
  delete window.GM_GLORY;
  delete window.GM_HISTORY;
  delete window.GM_SANCTIONS;
  delete window.GM_STATS;
  delete window.GM_ARMSRACE;
  delete window.GM_SHADOWFRONT;
  delete window.GM_TICKETS;
  delete window.GM_PORTAL;
  delete window.GM_SHELL;
  delete window.GM_MEMBERS;
  delete window.GM_ADMIN;
});

describe('dom-refs', () => {
  it('resolves lazily and reflects the current DOM', () => {
    expect(getDomRef('missing-node')).toBeNull();
    const node = document.createElement('div');
    node.id = 'lazy-node';
    document.body.appendChild(node);
    const refs = getDomRefs();
    expect(refs.adminMembersView).toBe(document.getElementById('admin-members'));
    expect(refs.loginView).toBe(document.getElementById('login-view'));
  });
});

describe('onTabActivated — visual switching', () => {
  it('toggles .active on the matching nav button and panel', async () => {
    await onTabActivated('admin-members', 'dashboard-view');

    const members = document.getElementById('admin-members');
    const home = document.getElementById('admin-home');
    expect(members.classList.contains('active')).toBe(true);
    expect(home.classList.contains('active')).toBe(false);

    const activeNav = Array.from(document.querySelectorAll('.nav-tab[data-tab="admin-members"]'));
    expect(activeNav.every((b) => b.classList.contains('active'))).toBe(true);
    expect(document.querySelector('.nav-tab[data-tab="admin-home"]').classList.contains('active')).toBe(false);
  });

  it('resets the anti-capture overlay and mobile-chat class', async () => {
    document.body.classList.add('gm-mobile-chat-open');
    document.getElementById('gm-anti-capture-fullscreen-overlay').classList.remove('hidden');

    await onTabActivated('gm-overview', 'dashboard-view');

    expect(document.getElementById('gm-anti-capture-fullscreen-overlay').classList.contains('hidden')).toBe(true);
    expect(document.body.classList.contains('gm-mobile-chat-open')).toBe(false);
  });

  it('blocks admin tab switching when user role is member', async () => {
    localStorage.setItem('gm_role', 'member');
    window.GM_MEMBERS.fetchGuildMembers = vi.fn();

    await onTabActivated('admin-members', 'dashboard-view');

    const members = document.getElementById('admin-members');
    expect(members.classList.contains('active')).toBe(false);
    expect(window.GM_MEMBERS.fetchGuildMembers).not.toHaveBeenCalled();
  });
});

describe('triggerTabDataLoad — /src domain routing', () => {
  it('routes member/admin tabs to GM_MEMBERS and GM_ADMIN', async () => {
    await triggerTabDataLoad('admin-members');
    expect(window.GM_MEMBERS.fetchGuildMembers).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('members');
    expect(window.GM_MEMBERS.fetchGuildMembers).toHaveBeenCalledTimes(2);

    await triggerTabDataLoad('admin-banned');
    expect(window.GM_MEMBERS.fetchBannedPlayers).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('accounts');
    expect(window.GM_ADMIN.fetchAccounts).toHaveBeenCalledTimes(1);
    expect(window.GM_ADMIN.loadGuildSettings).toHaveBeenCalledTimes(1);
    expect(window.GM_ADMIN.populateAccountGuildSelect).toHaveBeenCalledTimes(1);
    expect(window.GM_ADMIN.wireJoinCode).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('guild-settings');
    expect(window.GM_ADMIN.loadGuildSettings).toHaveBeenCalledTimes(2);

    await triggerTabDataLoad('guild-requests');
    expect(window.GM_ADMIN.fetchGuildRequests).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('subscriptions');
    expect(window.GM_ADMIN.renderGuildsSubscriptionList).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('migration-groups');
    expect(window.GM_ADMIN.renderMigrationGroupsList).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('admin-superadmin');
    expect(window.GM_ADMIN.renderGuildsSubscriptionList).toHaveBeenCalledTimes(2);
    expect(window.GM_ADMIN.renderMigrationGroupsList).toHaveBeenCalledTimes(2);
    expect(window.GM_ADMIN.fetchGuildRequests).toHaveBeenCalledTimes(2);
  });

  it('routes each migrated view tab to its window.GM_* loader', async () => {
    window.GM_OVERVIEW = { load: vi.fn() };
    window.GM_EVENTS = { loadEvent: vi.fn() };
    window.GM_GLORY = { load: vi.fn() };
    window.GM_HISTORY = { load: vi.fn() };
    window.GM_SANCTIONS = { load: vi.fn() };
    window.GM_STATS = { load: vi.fn() };
    window.GM_ARMSRACE = { load: vi.fn() };
    window.GM_SHADOWFRONT = { load: vi.fn() };
    window.GM_TICKETS = { load: vi.fn() };

    await triggerTabDataLoad('overview');
    await triggerTabDataLoad('event-svs');
    await triggerTabDataLoad('event-gvg');
    await triggerTabDataLoad('event-dtr');
    await triggerTabDataLoad('event-arms-race');
    await triggerTabDataLoad('event-shadowfront');
    await triggerTabDataLoad('event-glory');
    await triggerTabDataLoad('event-history');
    await triggerTabDataLoad('stats-admin');
    await triggerTabDataLoad('tab-sanctions');
    await triggerTabDataLoad('tab-tickets');

    expect(window.GM_OVERVIEW.load).toHaveBeenCalledTimes(1);
    expect(window.GM_EVENTS.loadEvent).toHaveBeenCalledWith('SvS');
    expect(window.GM_EVENTS.loadEvent).toHaveBeenCalledWith('GvG');
    expect(window.GM_EVENTS.loadEvent).toHaveBeenCalledWith('Defend Trade Route');
    expect(window.GM_ARMSRACE.load).toHaveBeenCalledTimes(1);
    expect(window.GM_SHADOWFRONT.load).toHaveBeenCalledTimes(1);
    expect(window.GM_GLORY.load).toHaveBeenCalledTimes(1);
    expect(window.GM_HISTORY.load).toHaveBeenCalledTimes(1);
    expect(window.GM_STATS.load).toHaveBeenCalledTimes(1);
    expect(window.GM_SANCTIONS.load).toHaveBeenCalledTimes(1);
    expect(window.GM_TICKETS.load).toHaveBeenCalledTimes(1);
  });

  it('is defensive: missing modules/functions never throw', async () => {
    delete window.GM_MEMBERS;
    delete window.GM_ADMIN;
    await expect(triggerTabDataLoad('overview')).resolves.toBeUndefined();
    await expect(triggerTabDataLoad('admin-members')).resolves.toBeUndefined();
    await expect(triggerTabDataLoad('event-unknown')).resolves.toBeUndefined();
    await expect(triggerTabDataLoad('')).resolves.toBeUndefined();
  });
});

describe('restoreSavedTab', () => {
  it('prefers gm_active_tab and delegates to the modern shell', () => {
    localStorage.setItem('gm_active_tab', 'admin-members');
    window.GM_SHELL = { gotoItem: vi.fn() };

    restoreSavedTab();

    expect(window.GM_SHELL.gotoItem).toHaveBeenCalledWith('admin-members');
  });

  it('falls back to gm_last_tab then activates the tab directly', async () => {
    localStorage.setItem('gm_last_tab', 'glory');
    window.GM_GLORY = { load: vi.fn() };

    restoreSavedTab();
    await tick();

    expect(window.GM_GLORY.load).toHaveBeenCalledTimes(1);
  });

  it('uses the default tab when no stored value exists', async () => {
    window.GM_OVERVIEW = { load: vi.fn() };

    restoreSavedTab();
    await tick();

    expect(window.GM_OVERVIEW.load).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when user role is member', () => {
    localStorage.setItem('gm_role', 'member');
    localStorage.setItem('gm_active_tab', 'admin-members');
    window.GM_SHELL = { gotoItem: vi.fn() };
    window.GM_OVERVIEW = { load: vi.fn() };

    restoreSavedTab();

    expect(window.GM_SHELL.gotoItem).not.toHaveBeenCalled();
    expect(window.GM_OVERVIEW.load).not.toHaveBeenCalled();
  });
});

describe('reloadActiveView', () => {
  it('reloads the currently active panel', async () => {
    window.GM_OVERVIEW = { load: vi.fn() };
    document.getElementById('admin-home').classList.remove('active');
    document.getElementById('gm-overview').classList.add('active');

    reloadActiveView();
    await tick();

    expect(window.GM_OVERVIEW.load).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no panel is active', async () => {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    reloadActiveView();
    await tick();
  });
});

describe('initTabNavigation', () => {
  it('binds delegated clicks and is idempotent', async () => {
    const container = document.getElementById('nav-container');
    window.GM_OVERVIEW = { load: vi.fn() };

    initTabNavigation(container);
    initTabNavigation(container);

    container.querySelector('[data-tab="gm-overview"]').click();
    await tick();
    expect(window.GM_OVERVIEW.load).toHaveBeenCalledTimes(1);
    expect(document.getElementById('gm-overview').classList.contains('active')).toBe(true);

    container.querySelector('[data-tab="admin-members"]').click();
    await tick();
    expect(window.GM_MEMBERS.fetchGuildMembers).toHaveBeenCalledTimes(1);
  });
});

describe('showAdminDashboard / showLogin', () => {
  it('toggles the login and dashboard containers', () => {
    showAdminDashboard();
    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(false);

    showLogin();
    expect(document.getElementById('dashboard-view').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('login-view').classList.contains('hidden')).toBe(false);
  });
});
