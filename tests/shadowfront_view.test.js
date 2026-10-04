/**
 * tests/shadowfront_view.test.js
 *
 * Post-cutover golden suite for the strict-TS `ShadowfrontView`
 * (src/modules/shadowfront/views/ShadowfrontView.ts), which now owns the
 * Shadowfront feature after the legacy root `shadowfront.js` removal.
 *
 * The former Phase-1 suite compared live output against shadowfront.js; with
 * the legacy file gone, this pins the same expected results as golden values
 * plus the cutover guard that the view exposes no `window.GM_SHADOWFRONT`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShadowfrontView } from '../src/modules/shadowfront/views/ShadowfrontView';
import { showToast } from '../src/core/dom/toast';

// The view imports showToast directly (no more `window.GM.showToast` read).
vi.mock('../src/core/dom/toast', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn()
}));

const GM = window.GM;

const MEMBERS = [
  { pseudo: 'Alpha', guild: 'ALPHA', uid: 'uid1', overall_power: 100000000 },
  { pseudo: 'Bravo', guild: 'ALPHA', uid: 'uid2', overall_power: 50000000 },
  { pseudo: 'Charlie', guild: 'ALPHA', uid: 'uid3', overall_power: 10000000 },
  { pseudo: 'Delta', guild: 'ALPHA', uid: 'uid4', overall_power: 75000000 }
];

let tables = {};

function chained(value) {
  const filters = [];
  let range = null;
  const chain = {
    select: () => chain,
    order: () => chain,
    eq: (field, val) => { filters.push((r) => r[field] === val); return chain; },
    in: (field, list) => { filters.push((r) => list.indexOf(r[field]) !== -1); return chain; },
    limit: () => chain,
    range: (from, to) => { range = [from, to]; return chain; },
    single: () => chain,
    delete: () => chain,
    maybeSingle: () => ({
      then: (resolve) => {
        let res = (value || []).slice();
        filters.forEach((f) => { res = res.filter(f); });
        return Promise.resolve({ data: res[0] || null, error: null }).then(resolve);
      }
    }),
    then: (resolve) => {
      let res = (value || []).slice();
      filters.forEach((f) => { res = res.filter(f); });
      if (range) res = res.slice(range[0], range[1] + 1);
      return Promise.resolve({ data: res, error: null }).then(resolve);
    }
  };
  return chain;
}

function installDb() {
  GM.db = {
    from: (table) => chained(tables[table] || []),
    functions: { invoke: vi.fn().mockResolvedValue({ data: { ok: false, error: 'n/a' } }) }
  };
}

function mount() {
  document.body.innerHTML = '<div id="event-shadowfront"><div class="event-participants-area"></div></div>';
}

function area() {
  return document.getElementById('event-shadowfront').querySelector('.event-participants-area');
}

function click(selector) {
  const el = document.querySelector(selector);
  if (el) el.click();
  return el;
}

function baseTables() {
  return {
    event_status: [
      { event_name: 'Shadowfront Squad 1', guild: 'ALPHA', is_active: true, session_id: 'S1', start_at: '2026-08-02T12:00:00Z' },
      { event_name: 'Shadowfront Squad 2', guild: 'ALPHA', is_active: false, session_id: null, start_at: null }
    ],
    guild_members: MEMBERS,
    shadowfront_squads: [
      { pseudo: 'Alpha', guild: 'ALPHA', session_id: 'S1', squad: 'squad1', role: 'participant', is_commander: true, week_start: '2026-08-02' }
    ],
    event_participants: [
      { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S1', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' }
    ],
    shadowfront_signups: [
      { pseudo: 'Alpha', guild: 'ALPHA', availability: 'squad1', week_start: '2026-08-02' },
      { pseudo: 'Bravo', guild: 'ALPHA', availability: 'squad2', week_start: '2026-08-02' },
      { pseudo: 'Delta', guild: 'ALPHA', availability: 'squad1', week_start: '2026-08-02' }
    ]
  };
}

async function runView(interactions = [], fixture = null) {
  mount();
  tables = fixture ? fixture() : baseTables();
  installDb();
  const view = new ShadowfrontView();
  await view.load();
  interactions.forEach((s) => click(s));
  return view;
}

beforeEach(() => {
  mount();
  localStorage.setItem('gm_role', 'guild_admin');
  window.currentGuildRestriction = 'ALPHA';
  vi.mocked(showToast).mockReset();
  tables = baseTables();
  installDb();
});

afterEach(() => {
  GM.db = null;
  document.body.innerHTML = '';
  delete window.currentGuildRestriction;
  vi.unstubAllGlobals();
});

describe('ShadowfrontView golden results (post shadowfront.js cutover)', () => {
  it('load renders the composition stepper, member pool and assigned squads', async () => {
    const view = await runView();
    const html = area().innerHTML;

    expect(html).toContain('1. Squad Composition');
    expect(html).toContain('2. Participation Tracking');
    expect(area().textContent).toContain('Bravo');
    expect(area().textContent).toContain('Alpha');
    expect(html).toContain('sf-share-discord-btn');

    const poolCol = area().querySelector('.sf-unassigned');
    expect(poolCol.textContent).not.toContain('Alpha');
    expect(poolCol.textContent).toContain('Bravo');
    expect(view.getAssignments()).toHaveLength(1);
    expect(view.getActiveSquadSession('squad1')).toBe('S1');
  });

  it('excludes Squad 1 members from the Squad 2 pool', async () => {
    await runView(['.sf-main-tab.squad2']);
    const pool = area().querySelector('.sf-unassigned');
    expect(pool.textContent).not.toContain('Alpha');
    expect(pool.textContent).toContain('Bravo');
  });

  it('unlocks tracking with the participation table and bulk actions', async () => {
    await runView(['.sf-step[data-tab="tracking"]']);
    const html = area().innerHTML;
    expect(html).toContain('sf-all-present-btn');
    expect(html).toContain('sf-all-absent-btn');
    expect(html).toContain('sf-participation-checkbox');
    expect(area().textContent).toContain('Alpha');
  });

  it('renders golden .sf-hist-stat fractions for participants and reserves', async () => {
    const fixture = () => {
      const t = baseTables();
      t.event_participants = [
        { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S1', participated: 1, late: false, excused: false, sub_present: false, week_start: '2026-08-02' },
        { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S2', participated: 1, late: false, excused: false, sub_present: false, week_start: '2026-08-09' },
        { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S1', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' }
      ];
      t.shadowfront_squads = [
        { pseudo: 'Alpha', guild: 'ALPHA', session_id: 'S1', squad: 'squad1', role: 'participant', is_commander: true, week_start: '2026-08-02' },
        { pseudo: 'Bravo', guild: 'ALPHA', session_id: 'S1', squad: 'squad1', role: 'reserve', is_commander: false, week_start: '2026-08-02' }
      ];
      return t;
    };

    await runView([], fixture);
    const stats = Array.from(document.querySelectorAll('#event-shadowfront .sf-assigned-row .sf-hist-stat')).map((el) => el.textContent);
    expect(stats).toEqual(['1/1', '-']);
  });

  it('resets the UI for an ended squad instead of keeping the composition', async () => {
    const fixture = () => {
      const t = baseTables();
      t.event_status = [
        { event_name: 'Shadowfront Squad 1', guild: 'ALPHA', is_active: false, session_id: 'S1', start_at: null },
        { event_name: 'Shadowfront Squad 2', guild: 'ALPHA', is_active: true, session_id: 'S2', start_at: '2026-08-05T12:00:00Z' }
      ];
      t.event_participants = [
        { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S1', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' },
        { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'Shadowfront', session_id: 'S2', participated: 0, late: false, excused: false, sub_present: false, week_start: '2026-08-02' }
      ];
      t.shadowfront_squads = [
        { pseudo: 'Alpha', guild: 'ALPHA', session_id: 'S1', squad: 'squad1', role: 'participant', is_commander: true, week_start: '2026-08-02' }
      ];
      return t;
    };

    await runView([], fixture);
    const html = area().innerHTML;
    expect(html).toContain('gm-empty-title');
    expect(html).not.toContain('1. Squad Composition');
    expect(html).not.toContain('2. Participation Tracking');
  });

  it('setStateForTest renders a directly injected state', async () => {
    const view = new ShadowfrontView();
    view.setStateForTest({
      squads: {
        squad1: { active: false, sessionId: null, startAt: null, ended: false },
        squad2: { active: false, sessionId: null, startAt: null, ended: false }
      },
      allMembers: ['Alpha', 'Bravo'],
      membersData: MEMBERS,
      assignments: [],
      participants: [],
      history: {},
      uidMap: { Alpha: 'uid1', Bravo: 'uid2' },
      signups: [],
      maxPower: 100000000
    });

    const html = area().innerHTML;
    expect(html).toContain('Member Pool');
    expect(area().textContent).toContain('Alpha');
    expect(area().textContent).toContain('Bravo');
    expect(html).toContain('data-tab="tracking"');
    expect(html).toContain('disabled');
  });

  it('shares the composition through the discord-webhook-proxy Edge Function', async () => {
    const fixture = () => {
      const t = baseTables();
      t.guild_config = [{ key: 'webhook_shadowfront', guild: 'ALPHA', value: 'https://discord.test/hook' }];
      return t;
    };

    mount();
    tables = fixture();
    installDb();
    const invokeMock = vi.fn().mockResolvedValue({ data: { ok: true } });
    GM.db.functions.invoke = invokeMock;

    const view = new ShadowfrontView();
    await view.load();
    click('.sf-share-discord-btn');
    await new Promise((r) => setTimeout(r, 0));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('discord-webhook-proxy', expect.objectContaining({
      body: expect.objectContaining({
        eventPrefix: 'shadowfront',
        guild: 'ALPHA',
        payload: expect.objectContaining({
          content: expect.stringContaining('Shadowfront'),
          allowed_mentions: { parse: ['roles', 'users', 'everyone'] }
        })
      })
    }));
    expect(showToast).toHaveBeenCalledWith('Composition sent to Discord.', 'success');
  });

  it('does not expose any window.GM_* global (cutover guard)', async () => {
    const baseline = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();

    const view = new ShadowfrontView();
    await view.load();

    const after = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();
    expect(after).toEqual(baseline);
    expect(window.GM_SHADOWFRONT).toBeUndefined();
  });
});
