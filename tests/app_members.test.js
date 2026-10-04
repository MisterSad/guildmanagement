/**
 * tests/app_members.test.js
 *
 * Sous-lot 6.6 — jsdom suite for the typed members modules ported from app.js
 * (roster cards/matrix, bulk role updates with R5 protection, transfers and
 * dialogs). Legacy app.js is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The members modules import showConfirm directly; the stub confirms at once.
vi.mock('../src/modules/app/dialogs/dialogs.service', async (importOriginal) => ({
  ...(await importOriginal()),
  showConfirm: vi.fn()
}));
import { showConfirm } from '../src/modules/app/dialogs/dialogs.service';

import { getAppState, patchAppState, resetAppState } from '../src/core/state/app-state';
import {
  setGuildMembers,
  setPendingTransfers,
  clearMembersStore
} from '../src/modules/app/members/members.store';
import {
  renderGuildMembers,
  buildMilitaryMatrixHtml,
  bulkUpdateMemberRoles,
  renderAbsenceSummary,
  renderTimezoneCoverage
} from '../src/modules/app/members/members.render';
import {
  renderPendingTransfers,
  resolveTransfer,
  showUidTakenDialog,
  showTransferMemberDialog
} from '../src/modules/app/members/members.controller';

const MEMBERS_DOM = `
  <div id="guild-member-list"></div><span id="guild-member-count">0</span>
  <input id="member-search-admin" />
  <select id="member-tier-filter-admin"><option value="ALL">ALL</option></select>
  <select id="member-sort-admin"><option value="power_desc">power</option></select>
  <div id="admin-members-view-mode">
    <button class="gm-seg-btn" data-view="cards"></button>
    <button class="gm-seg-btn" data-view="matrix"></button>
  </div>
  <div id="admin-members-bulk-bar"><span id="admin-bulk-selected-count"></span></div>
  <button id="admin-members-select-all-btn"><span></span><i></i></button>
  <button id="admin-bulk-clear-btn"></button>
  <div id="admin-absences-section"><span id="admin-absences-count"></span><div id="admin-absences-list"></div></div>
  <div id="admin-timezone-section"><span id="admin-timezone-count"></span><div id="admin-timezone-list"></div></div>
  <div id="admin-pending-transfers-section"><span id="admin-pending-transfers-count"></span><table><tbody id="admin-pending-transfers-list"></tbody></table></div>
  <div id="toast-container"></div>
`;

function makeDb(opts = {}) {
  const calls = { rpc: [], update: [], insert: [], delete: [], in: [] };
  function chain(table, data) {
    const obj = {
      select() { return obj; },
      eq() { return obj; },
      not() { return obj; },
      order() { return obj; },
      ilike() { return obj; },
      maybeSingle: async () => ({ data: opts.maybeSingle ? (opts.maybeSingle[table] ?? null) : null, error: null }),
      single: async () => ({ data: { id: 'x' }, error: null }),
      in: async (_col, vals) => { calls.in.push({ table, vals }); return { data: null, error: null }; },
      then: (resolve) => resolve({ data: data ?? [], error: null })
    };
    return obj;
  }
  return {
    __calls: calls,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      return opts.rpc ? opts.rpc(name, args) : { data: { ok: true }, error: null };
    },
    from(table) {
      return {
        select: () => chain(table, opts.tables ? opts.tables[table] : []),
        update: (payload) => { calls.update.push({ table, payload }); return chain(table); },
        insert: (payload) => { calls.insert.push({ table, payload }); return chain(table); },
        delete: () => { calls.delete.push({ table }); return chain(table); }
      };
    }
  };
}

const MEMBERS = [
  { pseudo: 'Leader', uid: '111111', role: 'R5', guild: 'ALPHA', overall_power: 100, created_at: '2026-01-01' },
  { pseudo: 'Officer', uid: '222222', role: 'R4', guild: 'ALPHA', overall_power: 90, fleet_rating: 5, created_at: '2026-01-02' },
  { pseudo: 'Bob', uid: '333333', role: 'R2', guild: 'ALPHA', overall_power: 80, tech_power: 7, timezone_offset: 2, created_at: '2026-01-03' },
  { pseudo: 'Recruit', uid: '444444', role: 'R1', guild: 'ALPHA', overall_power: 70, created_at: '2026-01-04' }
];

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = MEMBERS_DOM;
  localStorage.clear();
  resetAppState();
  clearMembersStore();
  setGuildMembers(MEMBERS);
  patchAppState({ adminMembersViewMode: 'cards', adminSelectedMembers: new Set(), guildAbsences: [] });

  window.GM = window.GM || {};
  window.GM.db = makeDb();
  window.currentGuild = 'ALPHA';
  showConfirm.mockReset();
  showConfirm.mockImplementation((_title, _msg, onConfirm) => { if (onConfirm) void onConfirm(); });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearMembersStore();
  resetAppState();
  document.body.innerHTML = '';
  delete window.GM_MEMBERS;
  delete window.currentGuild;
  localStorage.clear();
});

describe('renderGuildMembers — cards vs matrix', () => {
  it('renders role-grouped cards (R5 → R1) in cards mode', () => {
    renderGuildMembers();

    const container = document.getElementById('guild-member-list');
    expect(container.querySelectorAll('.gm-role-group-header').length).toBe(4);
    const roles = Array.from(container.querySelectorAll('.gm-role-group-header')).map((h) => h.getAttribute('data-role'));
    expect(roles).toEqual(['R5', 'R4', 'R2', 'R1']);
    expect(container.textContent).toContain('Leader');
    expect(container.textContent).toContain('Bob');
    expect(container.querySelector('[data-pseudo="Bob"]')).toBeTruthy();
  });

  it('renders the tactical matrix table in matrix mode', () => {
    patchAppState({ adminMembersViewMode: 'matrix' });
    renderGuildMembers();

    const container = document.getElementById('guild-member-list');
    expect(container.querySelector('.gm-table-wrap')).toBeTruthy();
    expect(container.querySelectorAll('tbody tr').length).toBe(4);
    // Role column values survive the matrix computation.
    const roleCells = Array.from(container.querySelectorAll('td[data-label="Role"]')).map((td) => td.textContent.trim());
    expect(roleCells).toEqual(expect.arrayContaining(['R5', 'R4', 'R2', 'R1']));
    // 4 rally leaders are auto-assigned when all have positive rally scores.
    expect(container.textContent).toContain('Tactical Force Matrix');
  });

  it('filters the roster by the admin search box', () => {
    document.getElementById('member-search-admin').value = 'bob';
    renderGuildMembers();
    const container = document.getElementById('guild-member-list');
    expect(container.querySelector('[data-pseudo="Bob"]')).toBeTruthy();
    expect(container.querySelector('[data-pseudo="Leader"]')).toBeNull();
  });

  it('buildMilitaryMatrixHtml returns an empty state for an empty roster', () => {
    setGuildMembers([]);
    const html = buildMilitaryMatrixHtml([], 'rally_desc', false, {});
    expect(html).toContain('gm-empty');
  });
});

describe('bulkUpdateMemberRoles — R5 protection', () => {
  it('refuses an R5 target role outright', async () => {
    const ok = await bulkUpdateMemberRoles('R5');
    expect(ok).toBe(false);
  });

  it('excludes a selected R5 leader and reports it', async () => {
    getAppState().adminSelectedMembers.add('Leader');
    const ok = await bulkUpdateMemberRoles('R2');
    expect(ok).toBe(false);
    expect(window.GM.db.__calls.update.length).toBe(0);
  });

  it('updates eligible members and never includes the R5 leader', async () => {
    const selected = getAppState().adminSelectedMembers;
    selected.add('Bob');
    selected.add('Leader');

    const ok = await bulkUpdateMemberRoles('R3');

    expect(ok).toBe(true);
    const updates = window.GM.db.__calls.update;
    expect(updates.length).toBe(1);
    expect(updates[0].payload.role).toBe('R3');
    const inCall = window.GM.db.__calls.in.find((c) => c.table === 'guild_members');
    expect(inCall.vals).toEqual(['Bob']);
    expect(selected.size).toBe(0);
  });

  it('reports when nothing eligible is selected', async () => {
    const ok = await bulkUpdateMemberRoles('R2');
    expect(ok).toBe(false);
  });
});

describe('pending transfers', () => {
  it('renders an incoming transfer with approve/reject actions', () => {
    setPendingTransfers([{ id: 't1', uid: '555555', pseudo: 'Mover', source_guild: 'BETA', target_guild: 'ALPHA' }]);
    renderPendingTransfers();

    const section = document.getElementById('admin-pending-transfers-section');
    expect(section.style.display).toBe('');
    expect(document.getElementById('admin-pending-transfers-count').textContent).toBe('1');
    const list = document.getElementById('admin-pending-transfers-list');
    expect(list.textContent).toContain('Mover');
    expect(list.querySelector('[data-transfer-action="approve"]')).toBeTruthy();
    expect(list.querySelector('[data-transfer-action="reject"]')).toBeTruthy();
  });

  it('hides the section when there are no pending transfers', () => {
    setPendingTransfers([]);
    renderPendingTransfers();
    expect(document.getElementById('admin-pending-transfers-section').style.display).toBe('none');
  });

  it('resolves a transfer through the RPC after confirmation', async () => {
    await resolveTransfer('t1', 'approve');
    await tick();
    expect(showConfirm).toHaveBeenCalled();
    expect(window.GM.db.__calls.rpc.map((c) => c.name)).toContain('resolve_guild_transfer');
    expect(window.GM.db.__calls.rpc.find((c) => c.name === 'resolve_guild_transfer').args)
      .toEqual({ p_transfer_id: 't1', p_action: 'approve' });
  });
});

describe('UID-taken dialog', () => {
  it('offers a transfer request for a player in another guild', async () => {
    await showUidTakenDialog('NewGuy', '666666', {
      ok: true,
      found: true,
      player: { pseudo: 'OldGuy', uid: '666666', guild: 'BETA', role: 'R2' },
      name_history: []
    });

    const overlay = document.getElementById('uid-taken-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('Player ID already exists');
    const requestBtn = document.getElementById('uid-taken-request-btn');
    expect(requestBtn.disabled).toBe(true);
    document.getElementById('uid-taken-confirm').checked = true;
    document.getElementById('uid-taken-confirm').dispatchEvent(new Event('change'));
    expect(requestBtn.disabled).toBe(false);

    requestBtn.click();
    await tick();
    expect(window.GM.db.__calls.rpc.map((c) => c.name)).toContain('gm_admin_request_transfer');
  });

  it('offers a rename when the player is already in the guild', async () => {
    await showUidTakenDialog('NewLeader', '111111', {
      ok: true,
      found: true,
      player: { pseudo: 'Leader', uid: '111111', guild: 'ALPHA', role: 'R5' },
      name_history: [{ old_pseudo: 'Old', new_pseudo: 'Leader', changed_at: '2026-01-01' }]
    });

    const overlay = document.getElementById('uid-taken-overlay');
    expect(overlay.textContent).toContain('Player Already in Guild');
    expect(document.getElementById('uid-rename-btn')).toBeTruthy();
    expect(overlay.textContent).toContain('Name history');
  });
});

describe('transfer member dialog', () => {
  it('lists eligible target guilds and submits the transfer RPC', async () => {
    window.GM.db = makeDb({
      maybeSingle: { guilds: { server_number: '1058' } },
      rpc: (name) => {
        if (name === 'gm_list_transfer_eligible_guilds') {
          return { data: [{ id: 'BETA', server_number: '1088', is_same_server: true }], error: null };
        }
        return { data: { ok: true }, error: null };
      }
    });

    await showTransferMemberDialog(MEMBERS[2]);

    const overlay = document.getElementById('transfer-member-overlay');
    expect(overlay).toBeTruthy();
    const select = document.getElementById('transfer-target-guild');
    expect(select.innerHTML).toContain('BETA');
    expect(overlay.textContent).toContain('1058');

    document.getElementById('confirm-transfer-btn').click();
    await tick();
    // Phase 3: `transfer_guild_member` was a one-line SQL wrapper around this,
    // with an identical signature and no check of its own. It is dropped.
    expect(window.GM.db.__calls.rpc.map((c) => c.name)).toContain('gm_transfer_guild_member');
  });

  it('warns when no guild is eligible', async () => {
    window.GM.db = makeDb({ rpc: () => ({ data: [], error: null }) });
    await showTransferMemberDialog(MEMBERS[2]);
    expect(document.getElementById('transfer-member-overlay')).toBeNull();
  });
});

describe('absences & timezone panels', () => {
  it('renders the absence summary for upcoming/active declarations', () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    patchAppState({ guildAbsences: [{ uid: '333333', start_date: '2026-01-01', end_date: future, kind: 'full', note: 'Vacation' }] });
    renderAbsenceSummary();
    const list = document.getElementById('admin-absences-list');
    expect(document.getElementById('admin-absences-section').style.display).toBe('');
    expect(list.textContent).toContain('Bob');
    expect(list.textContent).toContain('Vacation');
  });

  it('renders the timezone histogram for members with a declared offset', () => {
    renderTimezoneCoverage();
    expect(document.getElementById('admin-timezone-section').style.display).toBe('');
    expect(document.getElementById('admin-timezone-count').textContent).toContain('/4');
    expect(document.getElementById('admin-timezone-list').querySelectorAll('.gm-tz-bar-row').length).toBe(24);
  });
});
