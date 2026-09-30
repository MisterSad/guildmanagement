/**
 * tests/app_admin.test.js
 *
 * Sous-lot 6.5 — jsdom suite for the typed admin modules ported from app.js
 * (accounts rendering, pending registrations, migration groups, guilds).
 * Legacy app.js is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Phase 7: resolveRegistration refreshes the Overview through an import now.
vi.mock('../src/modules/overview/views/OverviewView', () => ({
  overviewView: { load: vi.fn(), destroy: vi.fn() }
}));
import { overviewView } from '../src/modules/overview/views/OverviewView';

import {
  fetchAccounts,
  fetchGuilds,
  populateAccountGuildSelect,
  deleteAccount,
  initAccountsUi
} from '../src/modules/app/admin/accounts.controller';
import {
  fetchGuildRequests,
  renderGuildRequestsList,
  renderPendingRegistrations,
  loadGuildSettings,
  resolveRegistration
} from '../src/modules/app/admin/guild-requests.controller';
import { renderMigrationGroupsList } from '../src/modules/app/admin/migration-groups.controller';
import { renderGuildsList } from '../src/modules/app/admin/guilds.controller';
import { clearAdminStore } from '../src/modules/app/admin/admin-store';

const ADMIN_DOM = `
  <div id="account-list"></div><span id="account-count">0</span>
  <div id="member-account-list"></div><span id="member-account-count">0</span>
  <div id="superadmin-account-list"></div><span id="superadmin-account-count">0</span>
  <div id="pending-account-list"></div><span id="pending-account-count">0</span>
  <div id="admin-pending-account-list"></div><span id="admin-pending-account-count">0</span>
  <div id="guild-requests-list"></div><span id="guild-requests-pending-count">0</span>
  <div id="guilds-list-container"></div>
  <div id="migration-groups-list-container"></div>
  <form id="create-migration-group-form">
    <input id="migration-group-name" />
    <input id="migration-group-servers" />
    <button type="submit"><span>Create</span></button>
  </form>
  <form id="guild-settings-form">
    <button type="submit"><span>Save</span></button>
  </form>
  <select id="account-guild"></select>
  <select id="superadmin-account-guild"></select>
  <div id="toast-container"></div>
`;

function makeDb(opts = {}) {
  const { guilds = [], groups = [], groupServers = [] } = opts;
  const calls = { update: [], insert: [] };
  const db = {
    __calls: calls,
    from(table) {
      if (table === 'guilds') {
        return {
          select: () => ({ order: async () => ({ data: guilds, error: null }) }),
          update: (payload) => ({ eq: async () => { calls.update.push({ table, payload }); return { data: null, error: null }; } }),
          insert: (payload) => { calls.insert.push({ table, payload }); return { select: () => ({ single: async () => ({ data: { id: 'new-group' }, error: null }) }) }; }
        };
      }
      if (table === 'server_migration_groups') {
        return {
          select: () => ({ order: async () => ({ data: groups, error: null }) }),
          insert: (payload) => ({ select: () => ({ single: async () => ({ data: { id: 'new-group' }, error: null }) }) }),
          update: (payload) => ({ eq: async () => { calls.update.push({ table, payload }); return { data: null, error: null }; } })
        };
      }
      if (table === 'server_migration_group_servers') {
        return {
          select: async () => ({ data: groupServers, error: null }),
          insert: async (payload) => { calls.insert.push({ table, payload }); return { data: null, error: null }; }
        };
      }
      return {};
    }
  };
  return db;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = ADMIN_DOM;
  localStorage.clear();
  clearAdminStore();
  window.GM = window.GM || {};
  window.GM.roleFromStorage = () => 'super_admin';
  window.GM.getActiveGuild = () => 'ALPHA';
  window.GM.adminAccounts = vi.fn(async (action) => (action === 'list' ? { ok: true, accounts: [] } : { ok: true }));
  window.GM.db = makeDb();
  window.currentGuild = 'ALPHA';
  window.showConfirm = vi.fn((_title, _msg, onConfirm) => { void onConfirm(); });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAdminStore();
  document.body.innerHTML = '';
  delete window.GM_ADMIN;
  delete window.showConfirm;
  delete window.currentGuild;
  localStorage.clear();
});

const ACCOUNTS = [
  { id: 'Super1', role: 'super_admin', guild: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 'AdminA', role: 'guild_admin', guild: 'ALPHA', created_at: '2026-01-02T00:00:00Z' },
  { id: 'MemberA', role: 'member', guild: 'ALPHA', created_at: '2026-01-03T00:00:00Z' },
  { id: 'Pending1', role: 'member', status: 'pending', guild: 'ALPHA', uid: '12345', created_at: '2026-01-04T00:00:00Z' }
];

describe('fetchAccounts + account cards', () => {
  it('renders admins, members and pending registrations by role', async () => {
    window.GM.adminAccounts = vi.fn(async (action) => (action === 'list' ? { ok: true, accounts: ACCOUNTS } : { ok: true }));

    await fetchAccounts();

    expect(document.getElementById('account-count').textContent).toBe('2');
    expect(document.getElementById('account-list').textContent).toContain('Super1');
    expect(document.getElementById('account-list').textContent).toContain('AdminA');
    expect(document.getElementById('account-list').querySelector('[data-acc-id="MemberA"]')).toBeNull();

    expect(document.getElementById('member-account-count').textContent).toBe('1');
    expect(document.getElementById('member-account-list').textContent).toContain('MemberA');

    expect(document.getElementById('admin-pending-account-count').textContent).toBe('1');
    expect(document.getElementById('admin-pending-account-list').textContent).toContain('Pending1');
    expect(document.getElementById('pending-account-list').textContent).toContain('Pending1');

    // Super admin sees role/guild selectors.
    expect(document.querySelectorAll('.gm-account-role-select').length).toBeGreaterThan(0);
    // Pending accounts are excluded from the active lists.
    expect(document.getElementById('account-list').textContent).not.toContain('Pending1');
  });

  it('renders role chips (no selectors) for a non-super-admin viewer', async () => {
    window.GM.roleFromStorage = () => 'guild_admin';
    window.GM.adminAccounts = vi.fn(async (action) => (action === 'list' ? { ok: true, accounts: ACCOUNTS } : { ok: true }));

    await fetchAccounts();

    expect(document.querySelectorAll('.gm-account-role-select').length).toBe(0);
    expect(document.getElementById('account-list').textContent).toContain('Guild Admin');
  });

  it('supports grouped super-admin rendering by server', async () => {
    window.guildsData = { ALPHA: { server_number: '1058' } };
    window.GM.adminAccounts = vi.fn(async (action) => (action === 'list' ? { ok: true, accounts: ACCOUNTS } : { ok: true }));

    await fetchAccounts();

    const grouped = document.getElementById('superadmin-account-list');
    expect(grouped.querySelector('.gm-accordion-header')).toBeTruthy();
    expect(grouped.textContent).toContain('Server #1058');

    delete window.guildsData;
  });

  // "none of us can actually view any of the passwords we're meant to give
  // each other" -- the create path generated a password and re-rendered the
  // card masked, with its Copy button hidden. The server now issues it and the
  // card must show it.
  it('shows the server-issued password on the new card after "Generate Access"', async () => {
    window.GM.roleFromStorage = () => 'guild_admin';
    window.GM.adminAccounts = vi.fn(async (action) => {
      if (action === 'list') return { ok: true, accounts: [] };
      if (action === 'create') return { ok: true, password: 'Srv3rIssued!Pw' };
      return { ok: true };
    });
    document.body.insertAdjacentHTML('beforeend',
      '<form id="create-account-form"><input id="account-id" value="NewOfficer" />' +
      '<button type="submit"><span>Generate Access</span></button></form>');
    document.getElementById('account-guild').innerHTML = '<option value="ALPHA" selected>ALPHA</option>';

    initAccountsUi();
    document.getElementById('create-account-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();

    const [, payload] = window.GM.adminAccounts.mock.calls.find(([a]) => a === 'create');
    expect(payload).not.toHaveProperty('password');
    const wrap = document.querySelector('.gm-cred-pass[data-acc-id="NewOfficer"]');
    expect(wrap).toBeTruthy();
    expect(wrap.classList.contains('gm-masked')).toBe(false);
    expect(wrap.querySelector('.gm-pwd-text').textContent).toBe('Srv3rIssued!Pw');
    expect(wrap.querySelector('.gm-cred-copy').classList.contains('hidden')).toBe(false);
  });

  it('removes an account through deleteAccount and re-renders', async () => {
    window.GM.adminAccounts = vi.fn(async (action) => {
      if (action === 'list') return { ok: true, accounts: ACCOUNTS };
      if (action === 'delete') return { ok: true };
      return { ok: true };
    });
    await fetchAccounts();
    await deleteAccount('AdminA');
    expect(window.GM.adminAccounts).toHaveBeenCalledWith('delete', { id: 'AdminA' });
    expect(document.getElementById('account-list').textContent).not.toContain('AdminA');
  });
});

describe('fetchGuilds / populateAccountGuildSelect', () => {
  it('populates window.guildsData and the super-admin guild select', async () => {
    window.GM.db = makeDb({ guilds: [{ id: 'ALPHA', server_number: 1058 }] });

    await fetchGuilds();
    populateAccountGuildSelect();

    expect(window.guildsList).toEqual(['ALPHA']);
    expect(window.guildsData.ALPHA.server_number).toBe(1058);
    const select = document.getElementById('superadmin-account-guild');
    expect(select.innerHTML).toContain('ALPHA');
    expect(select.innerHTML).toContain('#1058');

    delete window.guildsList;
    delete window.guildsData;
  });
});

describe('guild requests', () => {
  it('renders requests and wires approve/reject actions through showConfirm', async () => {
    window.GM.adminAccounts = vi.fn(async (action) => {
      if (action === 'list-guild-requests') {
        return { ok: true, requests: [{ id: 'req1', guild_tag: 'NEW', server_number: '1058', admin_id: 'admin1', discord_handle: 'a#1', status: 'pending', created_at: '2026-01-01' }] };
      }
      if (action === 'approve-guild-request') return { ok: true, password: 'PW', guild: 'NEW', id: 'admin1' };
      return { ok: true };
    });

    await fetchGuildRequests();

    const list = document.getElementById('guild-requests-list');
    expect(list.textContent).toContain('NEW');
    expect(document.getElementById('guild-requests-pending-count').textContent).toBe('1');

    const approveBtn = list.querySelector('.gm-guild-req-approve');
    expect(approveBtn).toBeTruthy();
    approveBtn.click();

    await vi.waitFor(() => expect(window.GM.adminAccounts).toHaveBeenCalledWith('approve-guild-request', { id: 'req1' }));
    expect(window.showConfirm).toHaveBeenCalled();
  });

  it('escapes malicious guild tags and notes (XSS invariant)', () => {
    renderGuildRequestsList([{
      id: 'req2',
      guild_tag: '<img src=x onerror=alert(1)>',
      server_number: '1058',
      admin_id: 'admin2',
      discord_handle: '<script>bad()</script>',
      status: 'pending',
      note: '<b>note</b>',
      created_at: '2026-01-01'
    }]);
    const html = document.getElementById('guild-requests-list').innerHTML;
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>bad');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('pending registrations', () => {
  it('renders pending accounts into both containers', async () => {
    window.GM.adminAccounts = vi.fn(async (action) => (action === 'list' ? { ok: true, accounts: ACCOUNTS } : { ok: true }));
    await fetchAccounts();

    await renderPendingRegistrations('ALPHA');

    expect(document.getElementById('pending-account-count').textContent).toBe('1');
    expect(document.getElementById('admin-pending-account-count').textContent).toBe('1');
    expect(document.getElementById('admin-pending-account-list').querySelector('.gm-pending-approve')).toBeTruthy();
    expect(document.getElementById('admin-pending-account-list').querySelector('.gm-pending-reject')).toBeTruthy();
  });

  it('approves a registration through resolveRegistration and refreshes', async () => {
    window.GM.adminAccounts = vi.fn(async (action) => {
      if (action === 'list') return { ok: true, accounts: ACCOUNTS };
      if (action === 'approve-registration') return { ok: true };
      return { ok: true };
    });
    await fetchAccounts();
    await renderPendingRegistrations('ALPHA');

    document.querySelector('.gm-pending-approve').click();

    await vi.waitFor(() => expect(window.GM.adminAccounts).toHaveBeenCalledWith('approve-registration', { id: 'Pending1' }));
    await vi.waitFor(() => expect(overviewView.load).toHaveBeenCalled());
  });

  it('rejects a registration through resolveRegistration', async () => {
    window.GM.adminAccounts = vi.fn(async (action) => {
      if (action === 'list') return { ok: true, accounts: ACCOUNTS };
      if (action === 'reject-registration') return { ok: true };
      return { ok: true };
    });
    await fetchAccounts();
    await renderPendingRegistrations('ALPHA');

    document.querySelector('.gm-pending-reject').click();

    await vi.waitFor(() => expect(window.GM.adminAccounts).toHaveBeenCalledWith('reject-registration', { id: 'Pending1' }));
  });
});

describe('loadGuildSettings', () => {
  it('loads config values and checkbox state into the form', async () => {
    const config = {};
    window.GM.config = {
      get: vi.fn(async (key) => (key in config ? config[key] : '')),
      set: vi.fn(async (key, value) => { config[key] = value; })
    };
    window.GM.getGuildTag = vi.fn(async () => '[FGF]');
    document.getElementById('guild-settings-form').insertAdjacentHTML('beforeend', '<input id="coeff-svs" /><input id="notify-svs-pvp" type="checkbox" /><input id="guild-tag-setting" /><input id="guild-server-number-setting" />');

    await loadGuildSettings();

    expect(document.getElementById('guild-tag-setting').value).toBe('[FGF]');
  });
});

describe('migration groups', () => {
  it('renders open groups with their servers and wires close/reopen', async () => {
    window.GM.db = makeDb({
      groups: [{ id: 'g1', name: 'EU Migration', status: 'open' }],
      groupServers: [{ group_id: 'g1', server_number: '1058' }, { group_id: 'g1', server_number: '1089' }]
    });

    await renderMigrationGroupsList();

    const container = document.getElementById('migration-groups-list-container');
    expect(container.textContent).toContain('EU Migration');
    expect(container.textContent).toContain('#1058');
    expect(container.textContent).toContain('#1089');
    expect(container.textContent).toContain('Open');

    const closeBtn = container.querySelector('[data-migration-group-action="close"]');
    expect(closeBtn).toBeTruthy();
    closeBtn.click();
    await tick();
    expect(window.showConfirm).toHaveBeenCalled();
    expect(window.GM.db.__calls.update.some((c) => c.table === 'server_migration_groups')).toBe(true);
  });

  it('renders the empty state when there are no groups', async () => {
    window.GM.db = makeDb({ groups: [] });
    await renderMigrationGroupsList();
    expect(document.getElementById('migration-groups-list-container').textContent).toContain('No migration groups yet');
  });
});

describe('guilds (server numbers + deletion)', () => {
  it('renders the guild list grouped by server, with the editor and delete control', async () => {
    window.GM.db = makeDb({ guilds: [{ id: 'ALPHA', server_number: '1058' }] });

    await renderGuildsList();

    const container = document.getElementById('guilds-list-container');
    expect(container.textContent).toContain('ALPHA');
    expect(container.textContent).toContain('Server #1058');
    expect(container.querySelector('.guild-server-number')).toBeTruthy();
    expect(container.querySelector('.save-guild-btn')).toBeTruthy();
    expect(container.querySelector('.delete-guild-btn')).toBeTruthy();
    // Phase 1: no subscription editor survives.
    expect(container.querySelector('.guild-sub-type')).toBeNull();
    expect(container.querySelector('.guild-sub-end')).toBeNull();
  });

  it('flags a guild with no server number, since transfers depend on it', async () => {
    window.GM.db = makeDb({ guilds: [{ id: 'BRAVO', server_number: null }] });
    await renderGuildsList();
    const container = document.getElementById('guilds-list-container');
    expect(container.textContent).toContain('Unassigned Server');
    expect(container.textContent).toContain('No server number');
  });

  it('renders the empty state when no guild exists', async () => {
    window.GM.db = makeDb({ guilds: [] });
    await renderGuildsList();
    expect(document.getElementById('guilds-list-container').textContent).toContain('No guild found');
  });
});
