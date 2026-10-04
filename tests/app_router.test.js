/**
 * tests/app_router.test.js
 *
 * Unit suite for the tab router.
 *
 * PHASE 7. This used to stub `window.GM_*` objects and assert the router called
 * them -- i.e. it tested the bridge, which is the thing being dismantled. The
 * router now imports its loaders directly, so the modules are mocked instead
 * and the assertions are about real function references. A rename that used to
 * leave this suite green while breaking a tab is now a compile error before the
 * suite even runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/modules/app/members/members.controller', () => ({ fetchGuildMembers: vi.fn() }));
vi.mock('../src/modules/app/members/banned.controller', () => ({ fetchBannedPlayers: vi.fn() }));
vi.mock('../src/modules/app/admin/accounts.controller', () => ({
  fetchAccounts: vi.fn(),
  fetchGuilds: vi.fn(),
  populateAccountGuildSelect: vi.fn(),
  wireJoinCode: vi.fn(),
  wireAdminInvite: vi.fn(),
  wireRecoveryCodesCard: vi.fn(),
  loadRecoveryCodesCard: vi.fn()
}));
vi.mock('../src/modules/app/admin/guild-requests.controller', () => ({
  loadGuildSettings: vi.fn(),
  fetchGuildRequests: vi.fn()
}));
vi.mock('../src/modules/app/admin/guilds.controller', () => ({ renderGuildsList: vi.fn() }));
vi.mock('../src/modules/app/admin/migration-groups.controller', () => ({ renderMigrationGroupsList: vi.fn() }));
vi.mock('../src/modules/migration/views/MigrationHubView', () => ({ migrationHubView: { load: vi.fn(), destroy: vi.fn() } }));
vi.mock('../src/modules/tickets/views/TicketsView', () => ({ ticketsView: { load: vi.fn() } }));
vi.mock('../src/modules/sanctions/views/SanctionsView', () => ({ sanctionsView: { init: vi.fn(), load: vi.fn(), destroy: vi.fn() } }));
vi.mock('../src/modules/overview/views/OverviewView', () => ({ overviewView: { load: vi.fn(), destroy: vi.fn() } }));
vi.mock('../src/modules/events/views/EventsView', () => ({ eventsView: { loadEvent: vi.fn() } }));
vi.mock('../src/modules/shadowfront/views/ShadowfrontView', () => ({ shadowfrontView: { load: vi.fn() } }));
vi.mock('../src/modules/armsrace/views/ArmsRaceView', () => ({ armsRaceView: { load: vi.fn() } }));
vi.mock('../src/modules/glory/views/GloryView', () => ({ gloryView: { load: vi.fn() } }));
vi.mock('../src/modules/history/views/HistoryView', () => ({ historyView: { load: vi.fn() } }));
vi.mock('../src/modules/stats/views/StatsView', () => ({ statsView: { load: vi.fn() } }));
vi.mock('../src/modules/portal/views/PortalView', () => ({ portalView: { loadDashboard: vi.fn() } }));
vi.mock('../src/modules/shell/views/ShellView', () => ({ shellView: { gotoItem: vi.fn(), renderShell: vi.fn(), renderSidebar: vi.fn(), renderTopbar: vi.fn() } }));

import { fetchGuildMembers } from '../src/modules/app/members/members.controller';
import { fetchBannedPlayers } from '../src/modules/app/members/banned.controller';
import {
  fetchAccounts,
  fetchGuilds,
  populateAccountGuildSelect,
  wireJoinCode
} from '../src/modules/app/admin/accounts.controller';
import { loadGuildSettings, fetchGuildRequests } from '../src/modules/app/admin/guild-requests.controller';
import { renderGuildsList } from '../src/modules/app/admin/guilds.controller';
import { renderMigrationGroupsList } from '../src/modules/app/admin/migration-groups.controller';
import { migrationHubView } from '../src/modules/migration/views/MigrationHubView';
import { ticketsView } from '../src/modules/tickets/views/TicketsView';
import { sanctionsView } from '../src/modules/sanctions/views/SanctionsView';
import { overviewView } from '../src/modules/overview/views/OverviewView';
import { eventsView } from '../src/modules/events/views/EventsView';
import { shadowfrontView } from '../src/modules/shadowfront/views/ShadowfrontView';
import { armsRaceView } from '../src/modules/armsrace/views/ArmsRaceView';
import { gloryView } from '../src/modules/glory/views/GloryView';
import { historyView } from '../src/modules/history/views/HistoryView';
import { statsView } from '../src/modules/stats/views/StatsView';
import { shellView } from '../src/modules/shell/views/ShellView';

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

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  // `restoreAllMocks` would restore the module mocks declared above to their
  // real implementations, so every test after the first would exercise the real
  // views. `clearAllMocks` resets the call records and keeps the mocks.
  vi.clearAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
  delete window.GM_SHELL;
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

    await onTabActivated('admin-members', 'dashboard-view');

    const members = document.getElementById('admin-members');
    expect(members.classList.contains('active')).toBe(false);
    expect(fetchGuildMembers).not.toHaveBeenCalled();
  });
});

describe('triggerTabDataLoad — /src domain routing', () => {
  it('routes member and admin tabs to the imported controllers', async () => {
    await triggerTabDataLoad('admin-members');
    expect(fetchGuildMembers).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('members');
    expect(fetchGuildMembers).toHaveBeenCalledTimes(2);

    await triggerTabDataLoad('admin-banned');
    expect(fetchBannedPlayers).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('accounts');
    expect(fetchAccounts).toHaveBeenCalledTimes(1);
    expect(loadGuildSettings).toHaveBeenCalledTimes(1);
    expect(populateAccountGuildSelect).toHaveBeenCalledTimes(1);
    expect(wireJoinCode).toHaveBeenCalledTimes(1);
    // The guild map has to be fetched on this tab: nothing else fills
    // window.guildsList, and the "Create Admin Account" dropdown reads it.
    expect(fetchGuilds).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('guild-settings');
    expect(loadGuildSettings).toHaveBeenCalledTimes(2);

    await triggerTabDataLoad('guild-requests');
    expect(fetchGuildRequests).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('guilds');
    expect(renderGuildsList).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('migration-groups');
    expect(renderMigrationGroupsList).toHaveBeenCalledTimes(1);

    await triggerTabDataLoad('admin-superadmin');
    expect(renderGuildsList).toHaveBeenCalledTimes(2);
    expect(renderMigrationGroupsList).toHaveBeenCalledTimes(2);
    expect(fetchGuildRequests).toHaveBeenCalledTimes(2);
    expect(fetchGuilds).toHaveBeenCalledTimes(2);
  });

  it('routes each view tab to its imported view module', async () => {
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
    await triggerTabDataLoad('migration-hub');

    expect(overviewView.load).toHaveBeenCalledTimes(1);
    expect(eventsView.loadEvent).toHaveBeenCalledWith('SvS');
    expect(eventsView.loadEvent).toHaveBeenCalledWith('GvG');
    expect(eventsView.loadEvent).toHaveBeenCalledWith('Defend Trade Route');
    expect(armsRaceView.load).toHaveBeenCalledTimes(1);
    expect(shadowfrontView.load).toHaveBeenCalledTimes(1);
    expect(gloryView.load).toHaveBeenCalledTimes(1);
    expect(historyView.load).toHaveBeenCalledTimes(1);
    expect(statsView.load).toHaveBeenCalledTimes(1);
    expect(sanctionsView.load).toHaveBeenCalledTimes(1);
    expect(ticketsView.load).toHaveBeenCalledTimes(1);
    expect(migrationHubView.load).toHaveBeenCalledTimes(1);
  });

  it('tears down the previous view when the tab changes', async () => {
    await triggerTabDataLoad('gm-overview');
    await triggerTabDataLoad('tab-sanctions');
    expect(overviewView.destroy).toHaveBeenCalledTimes(1);

    // Aliases of the same view must NOT tear it down.
    vi.clearAllMocks();
    await triggerTabDataLoad('overview');
    await triggerTabDataLoad('gm-overview');
    expect(overviewView.destroy).not.toHaveBeenCalled();
  });

  it('is defensive: a loader that throws never breaks the batch', async () => {
    fetchGuildMembers.mockRejectedValueOnce(new Error('boom'));
    await expect(triggerTabDataLoad('overview')).resolves.toBeUndefined();
    await expect(triggerTabDataLoad('admin-members')).resolves.toBeUndefined();
    await expect(triggerTabDataLoad('event-unknown')).resolves.toBeUndefined();
    await expect(triggerTabDataLoad('')).resolves.toBeUndefined();
  });
});

describe('restoreSavedTab', () => {
  it('prefers gm_active_tab and delegates to the shell', () => {
    localStorage.setItem('gm_active_tab', 'admin-members');
    restoreSavedTab();
    expect(shellView.gotoItem).toHaveBeenCalledWith('admin-members');
  });

  it('falls back to gm_last_tab', () => {
    // Phase 7: this used to assert the loader ran, by way of a fallback that
    // only fired when `window.GM_SHELL` was ABSENT -- which never happened in
    // production, where the bridge was always installed and `gotoItem` returned
    // first. The contract being tested is which storage key wins.
    localStorage.setItem('gm_last_tab', 'glory');
    restoreSavedTab();
    expect(shellView.gotoItem).toHaveBeenCalledWith('glory');
  });

  it('uses the default tab when no stored value exists', () => {
    restoreSavedTab();
    expect(shellView.gotoItem).toHaveBeenCalledWith('overview');
  });

  it('is a no-op when user role is member', () => {
    localStorage.setItem('gm_role', 'member');
    localStorage.setItem('gm_active_tab', 'admin-members');

    restoreSavedTab();

    expect(shellView.gotoItem).not.toHaveBeenCalled();
    expect(overviewView.load).not.toHaveBeenCalled();
  });
});

describe('reloadActiveView', () => {
  it('reloads the currently active panel', async () => {
    document.getElementById('admin-home').classList.remove('active');
    document.getElementById('gm-overview').classList.add('active');

    reloadActiveView();
    await tick();

    expect(overviewView.load).toHaveBeenCalledTimes(1);
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

    initTabNavigation(container);
    initTabNavigation(container);

    container.querySelector('[data-tab="gm-overview"]').click();
    await tick();
    expect(overviewView.load).toHaveBeenCalledTimes(1);
    expect(document.getElementById('gm-overview').classList.contains('active')).toBe(true);

    container.querySelector('[data-tab="admin-members"]').click();
    await tick();
    expect(fetchGuildMembers).toHaveBeenCalledTimes(1);
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
