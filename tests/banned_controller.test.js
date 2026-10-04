// `banned.controller.ts` was the one genuinely untested module the audit named
// that is still untested: 0.8% of statements, for a moderation action that
// removes a player from a guild and writes a ban row.
//
// The audit listed several others alongside it (`stats.service`,
// `shadowfront.service`, `db-guard`, `main.ts`), but measurement puts those at
// 70%, 74%, 96% and 51% -- they are exercised, indirectly. This one was not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/modules/app/members/members.render', () => ({
  renderGuildMembers: vi.fn(),
  membersSkeletonHtml: () => '',
}));
vi.mock('../src/modules/app/dialogs/dialogs.service', () => ({ showToast: vi.fn(), showConfirm: vi.fn() }));
// The controller imports validateUid directly; the stub lets a test choose the
// validator's verdict without depending on the real UID rules.
vi.mock('../src/core/utils/text', async (importOriginal) => ({
  ...(await importOriginal()),
  validateUid: vi.fn(() => ''),
}));

import {
  fetchBannedPlayers,
  renderBannedPlayers,
  handleAddBannedPlayer,
  deleteBannedPlayer,
} from '../src/modules/app/members/banned.controller';
import {
  getBannedPlayers,
  setBannedPlayers,
  setGuildMembers,
  getGuildMembers,
} from '../src/modules/app/members/members.store';
import { showToast, showConfirm } from '../src/modules/app/dialogs/dialogs.service';
import { validateUid } from '../src/core/utils/text';
import { renderGuildMembers } from '../src/modules/app/members/members.render';
import { setVerifiedRole } from '../src/core/auth/roles';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';

/** Records every filter so a test can prove which tenant was addressed. */
function fakeDb(responses = {}) {
  const calls = [];
  const builderFor = (table, op) => {
    const filters = {};
    const chain = {
      eq(col, val) {
        filters[col] = val;
        return chain;
      },
      order() {
        return chain;
      },
      then(resolve) {
        calls.push({ table, op, filters });
        const key = `${table}.${op}`;
        return Promise.resolve(responses[key] ?? { data: [], error: null }).then(resolve);
      },
    };
    return chain;
  };
  return {
    calls,
    rpc(name, args) {
      calls.push({ rpc: name, args });
      return Promise.resolve(responses[`rpc.${name}`] ?? { data: { ok: true, removed: null }, error: null });
    },
    from(table) {
      return {
        select: () => builderFor(table, 'select'),
        insert: (rows) => {
          calls.push({ table, op: 'insert', rows });
          return Promise.resolve(responses[`${table}.insert`] ?? { error: null });
        },
        delete: () => builderFor(table, 'delete'),
      };
    },
  };
}

function mountDom() {
  document.body.innerHTML =
    '<div id="banned-list-container"></div>' +
    '<form id="add-banned-form">' +
    '  <input id="banned-uid" />' +
    '  <input id="banned-pseudo" />' +
    '  <input id="banned-reason" />' +
    '  <button type="submit"></button>' +
    '</form>';
}

beforeEach(() => {
  mountDom();
  localStorage.clear();
  localStorage.setItem('gm_current_guild', 'ALPHA');
  setBannedPlayers([]);
  setGuildMembers([]);
  resetSupabaseClient();
  validateUid.mockImplementation(() => '');
  setVerifiedRole('super_admin', 'TheAdmin');
  // Banning a roster member now asks first (it erases their history); the
  // stub confirms and records what was shown.
  vi.clearAllMocks();
  showConfirm.mockImplementation((_title, _body, onConfirm) => {
    window.__confirmRun = Promise.resolve(onConfirm());
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  resetSupabaseClient();
  delete window.__confirmRun;
  localStorage.clear();
  setBannedPlayers([]);
  setGuildMembers([]);
});

describe('fetchBannedPlayers', () => {
  it('scopes the read to the active guild and stores the rows', async () => {
    const db = fakeDb({ 'banned_players.select': { data: [{ uid: '1', pseudo: 'Cheater' }], error: null } });
    setDbClient(db);

    await fetchBannedPlayers();

    const read = db.calls.find((c) => c.op === 'select');
    expect(read.filters.guild, 'a ban list must never be read across tenants').toBe('ALPHA');
    expect(getBannedPlayers()).toHaveLength(1);
  });

  it('surfaces a failure instead of silently emptying the list', async () => {
    setBannedPlayers([{ uid: 'keep', pseudo: 'Existing' }]);
    setDbClient(fakeDb({ 'banned_players.select': { data: null, error: { message: 'boom' } } }));

    await fetchBannedPlayers();

    expect(showToast).toHaveBeenCalled();
    expect(showToast.mock.calls[0][1]).toBe('error');
    expect(getBannedPlayers(), 'the previous list must survive a failed refresh').toHaveLength(1);
  });

  it('does nothing at all without a client', async () => {
    resetSupabaseClient();
    await expect(fetchBannedPlayers()).resolves.toBeUndefined();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('handleAddBannedPlayer', () => {
  it('refuses an empty uid without touching the database', async () => {
    const db = fakeDb();
    setDbClient(db);
    await handleAddBannedPlayer();
    expect(db.calls).toEqual([]);
  });

  it('refuses a uid the validator rejects, and says why', async () => {
    const db = fakeDb();
    setDbClient(db);
    validateUid.mockImplementation(() => 'toast_invalid_uid');
    document.getElementById('banned-uid').value = '123';

    await handleAddBannedPlayer();

    expect(db.calls).toEqual([]);
    expect(showToast).toHaveBeenCalledWith(expect.anything(), 'error');
  });

  it('refuses a duplicate rather than writing a second ban row', async () => {
    setBannedPlayers([{ uid: '900', pseudo: 'Cheater' }]);
    const db = fakeDb();
    setDbClient(db);
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();

    expect(db.calls.filter((c) => c.op === 'insert')).toEqual([]);
    expect(showToast).toHaveBeenCalledWith(expect.anything(), 'error');
  });

  // M4a: the ban and the removal are one call to gm_ban_member. The author is
  // the caller's account, read by the server -- the browser no longer sends it.
  it('bans in the active guild through one transactional call', async () => {
    const db = fakeDb();
    setDbClient(db);
    document.getElementById('banned-uid').value = '900';
    document.getElementById('banned-pseudo').value = 'Cheater';
    document.getElementById('banned-reason').value = 'bot';

    await handleAddBannedPlayer();

    const call = db.calls.find((c) => c.rpc === 'gm_ban_member');
    expect(call.args).toEqual({ p_guild: 'ALPHA', p_uid: '900', p_pseudo: 'Cheater', p_reason: 'bot' });
    expect(db.calls.filter((c) => c.op === 'insert' || c.op === 'delete')).toEqual([]);
  });

  it('sends null rather than empty strings for the optional fields', async () => {
    const db = fakeDb();
    setDbClient(db);
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();

    const call = db.calls.find((c) => c.rpc === 'gm_ban_member');
    expect(call.args.p_pseudo).toBeNull();
    expect(call.args.p_reason).toBeNull();
  });

  it('kicks the player from the roster when they are a current member', async () => {
    setGuildMembers([
      { uid: '900', pseudo: 'Cheater' },
      { uid: '901', pseudo: 'Innocent' },
    ]);
    const db = fakeDb({ 'rpc.gm_ban_member': { data: { ok: true, removed: 'Cheater' }, error: null } });
    setDbClient(db);
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();
    await window.__confirmRun;

    // It asked first, and said what the removal costs.
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(showConfirm.mock.calls[0][1]).toContain('Cheater');
    expect(
      db.calls.some((c) => c.rpc === 'gm_ban_member'),
      'the ban and the removal are one call'
    ).toBe(true);
    expect(getGuildMembers().map((m) => m.uid)).toEqual(['901']);
    expect(renderGuildMembers).toHaveBeenCalled();
  });

  it('keeps the roster as it was when the ban is refused', async () => {
    setGuildMembers([{ uid: '900', pseudo: 'Cheater' }]);
    const db = fakeDb({
      'rpc.gm_ban_member': { data: null, error: { message: 'cannot delete an R5', code: 'P0001' } },
    });
    setDbClient(db);
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();
    await window.__confirmRun;

    expect(getGuildMembers()).toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('cannot delete an R5'), 'error');
  });

  it('bans nothing when the officer cancels the confirmation', async () => {
    setGuildMembers([{ uid: '900', pseudo: 'Cheater' }]);
    const db = fakeDb();
    setDbClient(db);
    showConfirm.mockImplementation(() => {});
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();

    expect(db.calls).toHaveLength(0);
    expect(getGuildMembers()).toHaveLength(1);
  });

  it('refuses to ban the R5 leader', async () => {
    setGuildMembers([{ uid: '900', pseudo: 'Boss', role: 'R5' }]);
    const db = fakeDb();
    setDbClient(db);
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();

    expect(db.calls).toHaveLength(0);
    expect(showConfirm).not.toHaveBeenCalled();
  });

  it('does not touch the roster when the banned uid is not a member', async () => {
    setGuildMembers([{ uid: '901', pseudo: 'Innocent' }]);
    const db = fakeDb();
    setDbClient(db);
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();

    expect(db.calls.find((c) => c.table === 'guild_members')).toBeUndefined();
    expect(getGuildMembers()).toHaveLength(1);
  });

  it('keeps the roster intact when the kick itself fails', async () => {
    setGuildMembers([{ uid: '900', pseudo: 'Cheater' }]);
    setDbClient(fakeDb({ 'guild_members.delete': { error: { message: 'denied' } } }));
    document.getElementById('banned-uid').value = '900';

    await handleAddBannedPlayer();
    await window.__confirmRun;

    // The ban is recorded, but a refused delete must not make the UI claim the
    // player was removed.
    expect(getGuildMembers(), 'a failed kick must not drop the row locally').toHaveLength(1);
  });

  it('re-enables the submit button even when the ban fails', async () => {
    setDbClient(fakeDb({ 'rpc.gm_ban_member': { data: null, error: { message: 'boom' } } }));
    document.getElementById('banned-uid').value = '900';
    const btn = document.querySelector('#add-banned-form button[type="submit"]');

    await handleAddBannedPlayer();

    expect(btn.disabled, 'the form must not stay locked after a failure').toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.anything(), 'error');
  });
});

describe('deleteBannedPlayer', () => {
  it('scopes the delete to the active guild', async () => {
    setBannedPlayers([{ uid: '900', pseudo: 'Cheater' }]);
    const db = fakeDb();
    setDbClient(db);

    await deleteBannedPlayer('900');

    const del = db.calls.find((c) => c.table === 'banned_players' && c.op === 'delete');
    expect(del.filters).toMatchObject({ uid: '900', guild: 'ALPHA' });
    expect(getBannedPlayers()).toHaveLength(0);
  });

  it('keeps the row when the delete is refused', async () => {
    setBannedPlayers([{ uid: '900', pseudo: 'Cheater' }]);
    setDbClient(fakeDb({ 'banned_players.delete': { error: { message: 'denied' } } }));

    await deleteBannedPlayer('900');

    expect(getBannedPlayers(), 'a refused unban must not disappear locally').toHaveLength(1);
    expect(showToast).toHaveBeenCalledWith(expect.anything(), 'error');
  });
});

describe('renderBannedPlayers', () => {
  it('creates no live element from a hostile uid, pseudo or reason', () => {
    // Asserted on the DOM, not on `innerHTML`. Searching the serialised output
    // for `onerror=` looks right and proves nothing: `esc()` writes `&lt;img …`,
    // the parser decodes it into the ATTRIBUTE VALUE, and re-serialising prints
    // `<` raw again because `<` needs no escaping inside an attribute. The real
    // property is that nothing executable was constructed.
    setBannedPlayers([
      {
        uid: '<img src=x onerror=alert(1)>',
        pseudo: '<script>bad()</script>',
        reason: '"><b>owned</b>',
      },
    ]);
    renderBannedPlayers();

    const c = document.getElementById('banned-list-container');
    expect(c.querySelectorAll('img')).toHaveLength(0);
    expect(c.querySelectorAll('script')).toHaveLength(0);
    expect(c.querySelectorAll('[onerror]')).toHaveLength(0);
    // The `"><b>` reason must not have broken out of its attribute either.
    expect(c.querySelectorAll('b')).toHaveLength(0);
  });

  it('keeps the hostile value intact as text, rather than dropping it', () => {
    // Escaping must not silently swallow the data: an admin has to be able to
    // read the uid they banned.
    setBannedPlayers([{ uid: '<img src=x>', pseudo: 'X' }]);
    renderBannedPlayers();
    const row = document.querySelector('.gm-member-row');
    expect(row.getAttribute('data-uid')).toBe('<img src=x>');
    expect(document.getElementById('banned-list-container').textContent).toContain('<img src=x>');
  });

  it('is a no-op without its container, rather than throwing', () => {
    document.body.innerHTML = '';
    expect(() => renderBannedPlayers()).not.toThrow();
  });
});
