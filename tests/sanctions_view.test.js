/**
 * tests/sanctions_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/sanctions/views/SanctionsView.ts
 * in jsdom. The legacy root `sanctions.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SanctionsView } from '../src/modules/sanctions/views/SanctionsView';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';

// The view imports its collaborators directly; mock the source modules
// (there is no window bridge left to stub since M4c).
const mocks = vi.hoisted(() => ({ showToast: vi.fn(), showConfirm: vi.fn() }));

vi.mock('../src/core/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  t: (k) => k,
}));
vi.mock('../src/core/auth/roles', async (importOriginal) => ({
  ...(await importOriginal()),
  getActiveGuild: () => 'ALPHA',
}));
vi.mock('../src/core/dom/toast', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: mocks.showToast,
}));
vi.mock('../src/modules/app/dialogs/dialogs.service', async (importOriginal) => ({
  ...(await importOriginal()),
  showConfirm: mocks.showConfirm,
}));

let insertMock;
let deleteMock;
let showConfirmMock;
let sanctionsRows;

function chained(value) {
  const filters = [];
  const apply = () => {
    let res = (value || []).slice();
    filters.forEach((f) => {
      res = res.filter(f);
    });
    return res;
  };
  const chain = {
    select: () => chain,
    order: () => chain,
    eq: (field, val) => {
      filters.push((r) => r[field] === val);
      return chain;
    },
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve),
  };
  return chain;
}

function installDb(members) {
  insertMock = vi.fn(() => chained([{}]));
  deleteMock = vi.fn(() => chained([]));
  setDbClient({
    from: (table) => {
      if (table === 'guild_members') return chained(members);
      if (table === 'sanctions') {
        return {
          select: () => chained(sanctionsRows),
          insert: (payload) => {
            insertMock(payload);
            return chained([{}]);
          },
          delete: () => ({
            eq: (f, v) => {
              deleteMock(f, v);
              return chained([]);
            },
          }),
        };
      }
      return chained([]);
    },
  });
}

function installGM() {
  mocks.showToast.mockReset();
  mocks.showConfirm.mockReset();
  mocks.showConfirm.mockImplementation((_title, _body, cb) => {
    cb && cb();
  });
  showConfirmMock = mocks.showConfirm;
  resetSupabaseClient();
}

function mount() {
  document.body.innerHTML =
    '<div id="sanctions-count"></div>' +
    '<div id="member-list-datalist"></div>' +
    '<div id="sanctions-list"></div>' +
    '<form id="apply-sanction-form"><input id="sanction-player"><textarea id="sanction-comment"></textarea><button type="submit">Add</button></form>';
}

const MEMBERS = [
  { pseudo: 'Alpha', guild: 'ALPHA' },
  { pseudo: 'Bravo', guild: 'ALPHA' },
];

beforeEach(() => {
  mount();
  sanctionsRows = [
    {
      id: 1,
      pseudo: 'Alpha',
      comment: 'Late again',
      created_at: '2026-08-01T10:00:00Z',
      created_by: 'HawkEye',
      guild: 'ALPHA',
    },
  ];
  installGM();
  installDb(MEMBERS);
});

afterEach(() => {
  vi.useRealTimers();
  resetSupabaseClient();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SanctionsView.load()', () => {
  it('fills the member datalist, the list and the counter', async () => {
    const view = new SanctionsView();
    await view.load();

    const options = document.querySelectorAll('#member-list-datalist option');
    expect(options.length).toBe(2);
    expect(document.getElementById('sanctions-count').textContent).toBe('1');
    expect(document.querySelectorAll('#sanctions-list .gm-sanction-row').length).toBe(1);
    expect(document.getElementById('sanctions-list').textContent).toContain('Late again');
  });

  it('renders the empty state when there are no sanctions', async () => {
    sanctionsRows = [];
    const view = new SanctionsView();
    await view.load();
    expect(document.getElementById('sanctions-list').innerHTML).toContain('gm-empty-title');
    expect(document.getElementById('sanctions-count').textContent).toBe('0');
  });
});

describe('SanctionsView — form & delete', () => {
  it('adds a sanction on submit and reloads', async () => {
    const view = new SanctionsView();
    await view.load();
    view.init();

    document.getElementById('sanction-player').value = 'Bravo';
    document.getElementById('sanction-comment').value = 'No-show';
    document
      .getElementById('apply-sanction-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(insertMock).toHaveBeenCalledWith([{ guild: 'ALPHA', pseudo: 'Bravo', comment: 'No-show' }]);
    expect(mocks.showToast).toHaveBeenCalledWith('toast_sanction_added', 'success');

    view.destroy();
  });

  it('asks for confirmation then deletes', async () => {
    sanctionsRows = [
      { id: 9, pseudo: 'Alpha', comment: 'x', created_at: '2026-08-01T10:00:00Z', created_by: 'a', guild: 'ALPHA' },
    ];
    const view = new SanctionsView();
    await view.load();

    document.querySelector('#sanctions-list .sanction-delete-btn').click();
    await new Promise((r) => setTimeout(r, 0));

    expect(showConfirmMock).toHaveBeenCalledWith(
      'confirm_delete_sanction_title',
      'confirm_delete_sanction_body',
      expect.any(Function)
    );
    expect(deleteMock).toHaveBeenCalledWith('id', '9');
  });

  it('alerts on the 3rd accumulated sanction (recidivist)', async () => {
    vi.useFakeTimers();
    sanctionsRows = [
      { id: 1, pseudo: 'Alpha', comment: 'a', created_at: '2026-08-01', created_by: 'x', guild: 'ALPHA' },
      { id: 2, pseudo: 'Alpha', comment: 'b', created_at: '2026-08-01', created_by: 'x', guild: 'ALPHA' },
      { id: 3, pseudo: 'Alpha', comment: 'c', created_at: '2026-08-01', created_by: 'x', guild: 'ALPHA' },
    ];
    const view = new SanctionsView();
    await view.load();
    view.init();

    document.getElementById('sanction-player').value = 'Alpha';
    document.getElementById('sanction-comment').value = 'd';
    document
      .getElementById('apply-sanction-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.advanceTimersByTimeAsync(600);

    const titles = showConfirmMock.mock.calls.map((c) => c[0]);
    expect(titles).toContain('alert_recidivist');

    view.destroy();
  });

  it('removes the rad-lang-change listener on destroy()', () => {
    const view = new SanctionsView();
    view.init();
    const spy = vi.spyOn(window, 'removeEventListener');
    view.destroy();
    expect(spy).toHaveBeenCalledWith('rad-lang-change', expect.any(Function));
  });
});

describe('SanctionsView — cutover guard', () => {
  it('does not expose a GM_SANCTIONS global', async () => {
    const view = new SanctionsView();
    await view.load();
    expect('GM_SANCTIONS' in window).toBe(false);
  });
});
