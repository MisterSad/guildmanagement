/**
 * tests/portal_view.test.js
 *
 * Strangler Phase 1 behavioural suite for the strict-TS `PortalView`
 * (src/modules/portal/views/PortalView.ts). The legacy root `portal.js` stays
 * in place during this phase; this suite exercises the new module directly in
 * jsdom with a member-portal Edge Function mock, and guards the anti-shadowing
 * invariant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Phase 7: PortalView imports the badges service instead of probing
// `window.GM_BADGES`, so the stub below no longer intercepts it.
vi.mock('../src/modules/badges/badges.service', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, computeBadges: vi.fn() };
});
// Phase M4c: PortalView imports its helpers instead of reading `window.GM`.
// Chart drawing (canvas, absent in jsdom), the number formatter and the auth
// calls are mocked at their source module.
vi.mock('../src/core/dom/ui', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, drawScoreTrendChart: vi.fn(), attachNumberFormatter: vi.fn() };
});
vi.mock('../src/core/auth/session', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logout: vi.fn(async () => undefined), loginWithDiscord: vi.fn() };
});
import { computeBadges } from '../src/modules/badges/badges.service';
import { drawScoreTrendChart } from '../src/core/dom/ui';
import { PortalView, submitErrorMessage } from '../src/modules/portal/views/PortalView';
import { resetSupabaseClient } from '../src/core/api/supabase';

const FIXTURES = {
  'get-active-sessions': {
    ok: true, pseudo: 'AlphaPrime', guild: 'ALPHA',
    overall_power: 80000000, timezone_offset: 1, glory: 5000,
    sessions: [{ event_name: 'GvG', session_id: 'GVG-2026-W32', start_at: null, participated: true, score_prep: 1000, is_pending: false, validated: true, in_session: true }]
  },
  'get-history': { ok: true, events: {} },
  'get-personal-kpis': {
    ok: true,
    power: { current: 80000000, guild_max: 100000000, rank: 3, members: 20, percentile: 15, guild_avg: 70000000 },
    glory: { current_week: 5000, rank: 2, guild_max_week: 9000, best_ever: 7000, guild_avg_week: 4000 },
    participation: { rate: 75, attended: 9, total: 12, guild_avg_rate: 70 },
    role: 'R3'
  },
  'get-weekly-challenges': {
    ok: true, week: '2026-08-03',
    challenges: [
      { id: 'events1', label: 'Attend 1 event this week', icon: 'ph-calendar-check', done: true, progress: 1, target: 1 },
      { id: 'events3', label: 'Attend 3 events this week', icon: 'ph-lightning', done: false, progress: 1, target: 3 }
    ],
    completed: 1, total: 2,
    season: { level: 'Silver', events: 9 }
  },
  'get-badges': { ok: true, role: 'R3', created_at: '2026-06-01T00:00:00Z', overall_power: 80000000, attended: 12, glory_best: 4000 },
  'get-transfer-guilds': { ok: true, guilds: [] },
  'get-absences': { ok: true, absences: [] }
};

let invokeMock;

function installDb() {
  invokeMock = vi.fn(async (_fn, opts) => {
    const action = opts && opts.body ? opts.body.action : undefined;
    const reply = FIXTURES[action] || { ok: true };
    return { data: reply, error: null };
  });
  window.GM.db = { functions: { invoke: invokeMock } };
  resetSupabaseClient();
}

function installGlobals() {
  window.GM = window.GM || {};
  vi.mocked(drawScoreTrendChart).mockClear();

  vi.mocked(computeBadges).mockReturnValue({
    earned: 1,
    total: 1,
    categories: [{ key: 'power', label: 'Power', icon: 'ph-lightning', color: '#ffe088', badges: [
      { category: 'power', earned: true, current: 80000000, target: 100000000, progress: 100, color: '#ffe088', icon: 'ph-lightning', name: 'High Power', desc: 'Reach 100M power' }
    ] }]
  });
  window.GM_PUSH = { mount: vi.fn() };
}

function mountDom() {
  document.body.innerHTML =
    '<div id="player-portal-view" class="hidden"></div>' +
    '<div id="login-view" class="hidden"></div>' +
    '<div id="portal-dashboard-root"></div>';
}

function root() {
  return document.getElementById('portal-dashboard-root');
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function newView() {
  return new PortalView();
}

beforeEach(() => {
  mountDom();
  localStorage.clear();
  installGlobals();
  installDb();
  window.requestAnimationFrame = (cb) => { cb(0); return 0; };
});

afterEach(() => {
  delete window.requestAnimationFrame;
  resetSupabaseClient();
  delete window.GM.db;
  delete window.GM_PUSH;
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('PortalView — loadDashboard()', () => {
  it('loads the player, sessions and renders the portal shell', async () => {
    const view = newView();
    await view.loadDashboard();

    expect(view.getState().player.pseudo).toBe('AlphaPrime');
    expect(view.getState().sessions).toHaveLength(1);
    expect(root().querySelector('.portal-shell')).toBeTruthy();
    expect(root().querySelector('.gm-bottom-nav')).toBeTruthy();
    expect(root().querySelector('[data-portal-drawer]')).toBeTruthy();
  });

  it('renders the 6 panels', async () => {
    const view = newView();
    await view.loadDashboard();

    ['dashboard', 'challenges', 'badges', 'events', 'absence', 'settings'].forEach((name) => {
      expect(document.getElementById('portal-panel-' + name), name).toBeTruthy();
    });
  });

  it('shows the retry / reconnect error screen when the edge function fails', async () => {
    invokeMock.mockImplementation(async (_fn, opts) => {
      if (opts.body.action === 'get-active-sessions') {
        return { data: null, error: { message: 'unauthorized' } };
      }
      return { data: { ok: true }, error: null };
    });

    const view = newView();
    await view.loadDashboard();

    expect(root().textContent).toContain('Unable to load your portal');
    expect(root().querySelector('[data-portal-error-retry]')).toBeTruthy();
    expect(root().querySelector('[data-portal-error-signout]')).toBeTruthy();
  });
});

describe('PortalView — gotoTab() lazy panels', () => {
  it('switches panels and lazily loads challenges, badges, events, and absence', async () => {
    const view = newView();
    await view.loadDashboard();

    const clickNav = (id) => {
      const btn = root().querySelector('[data-portal-nav="' + id + '"]');
      btn.click();
    };

    clickNav('challenges');
    await tick();
    expect(document.getElementById('portal-panel-challenges').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('portal-challenges-body').textContent).toContain('Attend 1 event');

    clickNav('badges');
    await tick();
    expect(computeBadges).toHaveBeenCalled();
    expect(document.getElementById('portal-badges-body').textContent).toContain('High Power');

    clickNav('events');
    expect(document.getElementById('portal-panel-events').textContent).toContain('GvG');
    // The server returns each session's fields flat; the card used to read a
    // `current_data` key that never existed and always said "Not submitted yet".
    expect(document.getElementById('portal-panel-events').textContent).toContain('Confirmed by an officer');
    expect(document.querySelector('#portal-panel-events .portal-submit-event-btn')).toBeNull();

    clickNav('absence');
    await tick();
    expect(document.getElementById('portal-absence-body').textContent).toContain('Declare a period');
  });
});

describe('PortalView — chart delegation & cleanup', () => {
  it('delegates chart drawing to drawScoreTrendChart', async () => {
    FIXTURES['get-history'] = {
      ok: true,
      events: { 'SvS': { has_score: true, history: [{ week_start: '2026-08-03', score: 100 }] } }
    };
    const view = newView();
    await view.loadDashboard();

    expect(root().querySelector('.portal-chart-canvas')).toBeTruthy();
    expect(drawScoreTrendChart).toHaveBeenCalled();
  });

  it('destroy() removes the resize listener and is safe before any render', () => {
    const view = newView();
    expect(() => view.destroy()).not.toThrow();

    const spy = vi.spyOn(window, 'removeEventListener');
    return view.loadDashboard().then(() => {
      view.destroy();
      expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));
    });
  });

  it('does not expose any window.GM_* global', async () => {
    const baseline = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();

    const view = newView();
    await view.loadDashboard();

    const after = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('GM_')).sort();
    expect(after).toEqual(baseline);
    expect(window.GM_PORTAL).toBeUndefined();
  });
});


describe('PortalView — Active Events card states', () => {
  const baseSessions = FIXTURES['get-active-sessions'].sessions;
  afterEach(() => { FIXTURES['get-active-sessions'].sessions = baseSessions; });

  async function renderEvents(sessions) {
    FIXTURES['get-active-sessions'].sessions = sessions;
    const view = newView();
    await view.loadDashboard();
    root().querySelector('[data-portal-nav="events"]').click();
    return document.getElementById('portal-panel-events');
  }

  it('shows a pending submission as awaiting approval, with its button disabled', async () => {
    const panel = await renderEvents([{ event_name: 'Defend Trade Route', session_id: 'DTR-20260930-1', participated: true, is_pending: true, validated: false, in_session: true }]);
    expect(panel.textContent).toContain('Awaiting approval');
    expect(panel.querySelector('.portal-submit-event-btn').disabled).toBe(true);
  });

  it('treats a squad-named Shadowfront session as Shadowfront: no score field, late/excused toggles', async () => {
    const panel = await renderEvents([{ event_name: 'Shadowfront Squad 1', session_id: 'SF1-20260930-1', participated: false, is_pending: false, validated: false, in_session: true }]);
    expect(panel.querySelector('.portal-score')).toBeNull();
    expect(panel.querySelector('.portal-check-late')).not.toBeNull();
    expect(panel.querySelector('.portal-submit-event-btn')).not.toBeNull();
  });

  it('offers no toggle the server would discard (appointed, excused)', async () => {
    const dtr = await renderEvents([{ event_name: 'Defend Trade Route', session_id: 'DTR-20260930-1', is_pending: false, validated: false, in_session: true }]);
    expect(dtr.querySelector('.portal-check-appointed')).toBeNull();
    const sf = await renderEvents([{ event_name: 'Shadowfront Squad 1', session_id: 'SF1-20260930-1', is_pending: false, validated: false, in_session: true }]);
    expect(sf.querySelector('.portal-check-excused')).toBeNull();
  });

  it('tells a player outside the squad so, instead of offering a Submit that cannot land', async () => {
    const panel = await renderEvents([{ event_name: 'Shadowfront Squad 2', session_id: 'SF2-20260930-1', is_pending: false, validated: false, in_session: false }]);
    expect(panel.textContent).toContain('Not in this squad');
    expect(panel.querySelector('.portal-submit-event-btn')).toBeNull();
  });
});

describe('submitErrorMessage', () => {
  it('explains each refusal in player terms', () => {
    expect(submitErrorMessage('score_already_validated')).toMatch(/already recorded/);
    expect(submitErrorMessage('not_in_session')).toMatch(/not part of this event/);
    expect(submitErrorMessage('session_inactive')).toMatch(/ended/);
    expect(submitErrorMessage('boom')).toBe('Submission failed. Please try again.');
  });
});
