/**
 * tests/armsrace_view.test.js
 *
 * Strangler Phase 1 behavioural suite for the strict-TS `ArmsRaceView`
 * (src/modules/armsrace/views/ArmsRaceView.ts). The legacy root `armsrace.js`
 * stays in place during this phase; this suite exercises the new module
 * directly in jsdom and guards the anti-shadowing invariant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArmsRaceView } from '../src/modules/armsrace/views/ArmsRaceView';

// The view imports its helpers directly (no more `window.GM.*` reads). Keep
// i18n as the identity so assertions can match translation keys.
vi.mock('../src/core/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  t: (k) => k
}));

const STAGE_A = 'ARMS RACE STAGE A';
const STAGE_B = 'ARMS RACE STAGE B';
const SESSION_A = 'ARA-20260802-1';

let tables = {};
let views = [];

function chained(value) {
  const filters = [];
  const apply = () => {
    let res = (value || []).slice();
    filters.forEach((f) => { res = res.filter(f); });
    return res;
  };
  const chain = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    single: () => chain,
    eq: (field, val) => { filters.push((r) => r[field] === val); return chain; },
    neq: (field, val) => { filters.push((r) => r[field] !== val); return chain; },
    in: (field, list) => { filters.push((r) => list.indexOf(r[field]) !== -1); return chain; },
    update: () => chain,
    upsert: () => chain,
    insert: () => chain,
    delete: () => chain,
    maybeSingle: () => ({ then: (resolve) => Promise.resolve({ data: apply()[0] || null, error: null }).then(resolve) }),
    then: (resolve, reject) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject)
  };
  return chain;
}

function installDb() {
  window.GM.db = {
    from: (table) => chained(tables[table] || []),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null })
  };
}

function baseTables() {
  return {
    event_status: [
      { event_name: STAGE_A, guild: 'ALPHA', is_active: true, session_id: SESSION_A, start_at: '2026-08-02T12:00:00Z' },
      { event_name: STAGE_B, guild: 'ALPHA', is_active: false, session_id: null, start_at: null }
    ],
    guild_members: [
      { pseudo: 'Alpha', guild: 'ALPHA', uid: 'uid1' },
      { pseudo: 'Bravo', guild: 'ALPHA', uid: 'uid2' },
      { pseudo: 'Charlie', guild: 'ALPHA', uid: 'uid3' }
    ],
    event_participants: [
      { pseudo: 'Alpha', guild: 'ALPHA', event_name: STAGE_A, session_id: SESSION_A, participated: 1, week_start: '2026-08-02' },
      { pseudo: 'Bravo', guild: 'ALPHA', event_name: STAGE_A, session_id: SESSION_A, participated: 0, week_start: '2026-08-02' }
    ]
  };
}

function installGM() {
  // Only the Supabase client is still read from `window.GM` (via getClient()).
  window.GM = { db: null };
}

function mount() {
  document.body.innerHTML = '<div id="event-arms-race"><div class="event-participants-area"></div></div>';
}

function area() {
  return document.getElementById('event-arms-race').querySelector('.event-participants-area');
}

function rows() {
  return Array.from(area().querySelectorAll('.participant-row'));
}

function rowFor(pseudo) {
  return rows().find((r) => r.getAttribute('data-pseudo') === pseudo);
}

function newView() {
  const view = new ArmsRaceView();
  views.push(view);
  return view;
}

beforeEach(() => {
  mount();
  localStorage.setItem('gm_role', 'guild_admin');
  tables = baseTables();
  installGM();
  installDb();
});

afterEach(() => {
  views = [];
  delete window.GM;
  delete window.showConfirm;
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ArmsRaceView — load & render', () => {
  it('renders Stage A / Stage B tabs and the active Stage A roster', async () => {
    const view = newView();
    await view.load();

    const html = area().innerHTML;
    expect(html).toContain('Stage A');
    expect(html).toContain('Stage B');
    expect(area().querySelector('.sf-main-tab.stageA').classList.contains('active')).toBe(true);
    expect(area().querySelector('.sf-main-tab.stageB').classList.contains('active')).toBe(false);
    expect(rows().map((r) => r.getAttribute('data-pseudo')).sort()).toEqual(['Alpha', 'Bravo']);
    // Alpha participated → 1 done, 1 absent chips.
    const chips = area().querySelectorAll('.event-stats .gm-chip');
    expect(chips[1].textContent).toContain('1');
    expect(chips[2].textContent).toContain('1');
    expect(view.getState().stages.stageA.sessionId).toBe(SESSION_A);
  });

  it('renders an inactive Stage B with the empty state (no participant rows)', async () => {
    const view = newView();
    await view.load();

    area().querySelector('.sf-main-tab.stageB').click();

    expect(area().querySelector('.sf-main-tab.stageB').classList.contains('active')).toBe(true);
    expect(area().querySelector('.sf-main-tab.stageA').classList.contains('active')).toBe(false);
    expect(rows()).toHaveLength(0);
    expect(area().innerHTML).toContain('gm-empty-title');
  });

  it('always renders even when the data layer throws (panel never blank)', async () => {
    window.GM.db = {
      from: () => { throw new Error('network down'); },
      rpc: vi.fn()
    };
    const view = newView();
    await view.load();

    expect(area().innerHTML).toContain('sf-main-tabs');
    expect(area().innerHTML).toContain('gm-empty-title');
  });

  it('renders the "no members" empty state for an active stage without participants', async () => {
    tables.event_participants = [];
    const view = newView();
    await view.load();

    expect(area().innerHTML).toContain('gm-empty');
    expect(rows()).toHaveLength(0);
    expect(area().textContent).toContain('empty_members');
  });
});

describe('ArmsRaceView — tab switching', () => {
  it('switches between Stage A and Stage B and back', async () => {
    const view = newView();
    await view.load();

    area().querySelector('.sf-main-tab.stageB').click();
    expect(area().querySelector('.sf-main-tab.stageB').classList.contains('active')).toBe(true);
    expect(rows()).toHaveLength(0);

    area().querySelector('.sf-main-tab.stageA').click();
    expect(area().querySelector('.sf-main-tab.stageA').classList.contains('active')).toBe(true);
    expect(rows()).toHaveLength(2);
  });
});

describe('ArmsRaceView — in-memory member sync', () => {
  it('adds a member to the active stage and removes it again', async () => {
    const view = newView();
    await view.load();
    expect(rows()).toHaveLength(2);

    const added = await view.addMemberToActiveEvents('Charlie');
    expect(added).toBe(1);
    expect(rows().map((r) => r.getAttribute('data-pseudo'))).toContain('Charlie');
    expect(rows().map((r) => r.getAttribute('data-pseudo'))).toEqual(['Alpha', 'Bravo', 'Charlie']);

    view.removeMemberFromActiveEvents('Charlie');
    expect(rows().map((r) => r.getAttribute('data-pseudo'))).toEqual(['Alpha', 'Bravo']);
  });

  it('is a no-op when no stage is active', async () => {
    tables.event_status = [
      { event_name: STAGE_A, guild: 'ALPHA', is_active: false, session_id: SESSION_A, start_at: null },
      { event_name: STAGE_B, guild: 'ALPHA', is_active: false, session_id: null, start_at: null }
    ];
    const view = newView();
    await view.load();

    expect(await view.addMemberToActiveEvents('Charlie')).toBe(0);
    expect(view.getState().stages.stageA.participants.map((p) => p.pseudo)).not.toContain('Charlie');
  });
});

describe('ArmsRaceView — local search & participation', () => {
  it('filters participant rows locally by pseudo or uid', async () => {
    const view = newView();
    await view.load();

    const input = area().querySelector('.event-search-input');
    input.value = 'bravo';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(rowFor('Alpha').style.display).toBe('none');
    expect(rowFor('Bravo').style.display).toBe('');

    input.value = 'uid1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rowFor('Alpha').style.display).toBe('');
    expect(rowFor('Bravo').style.display).toBe('none');
  });

  it('updates the participation chips when a checkbox is toggled', async () => {
    const view = newView();
    await view.load();

    const bravoCb = rowFor('Bravo').querySelector('.participation-checkbox');
    bravoCb.checked = true;
    bravoCb.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const chips = area().querySelectorAll('.event-stats .gm-chip');
    expect(chips[1].textContent).toContain('2'); // done
    expect(chips[2].textContent).toContain('0'); // absent
    expect(rowFor('Bravo').classList.contains('participated')).toBe(true);
    expect(view.getState().stages.stageA.participants.find((p) => p.pseudo === 'Bravo').participated).toBe(1);
  });
});

describe('ArmsRaceView — cutover guard', () => {
  it('does not expose any window.GM_* global', async () => {
    const baseline = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();

    const view = newView();
    await view.load();

    const after = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();
    expect(after).toEqual(baseline);
    expect(window.GM_ARMSRACE).toBeUndefined();
  });
});
