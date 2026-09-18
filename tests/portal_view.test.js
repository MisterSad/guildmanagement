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
import { PortalView } from '../src/modules/portal/views/PortalView';
import { resetSupabaseClient } from '../src/core/api/supabase';

const FIXTURES = {
  'get-active-sessions': {
    ok: true, pseudo: 'AlphaPrime', guild: 'ALPHA',
    overall_power: 80000000, timezone_offset: 1, glory: 5000,
    sessions: [{ event_name: 'GvG', session_id: 'GVG-2026-W32', start_at: null, current_data: { participated: 1, score_prep: 1000 } }]
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
  'get-push-prefs': { ok: true, event_types: ['events', 'glory', 'challenges'] },
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
  const g = (window.GM = window.GM || {});
  g.escapeHTML = (s) => String(s ?? '');
  g.avatarInit = (s) => String(s || '').slice(0, 1).toUpperCase();
  g.logout = vi.fn().mockResolvedValue(undefined);
  g.formatPower = (v) => String(v ?? 0);
  g.formatNumber = (v) => String(v ?? 0);
  g.getEventIcon = () => 'ph-calendar';
  g.drawScoreTrendChart = vi.fn();
  g.attachNumberFormatter = vi.fn();
  g.parseNumber = (v) => parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 0;
  g.showToast = vi.fn();
  g.calculateCombatDensity = () => 80;
  g.calculateResidualPower = () => 1000;
  g.calculateCombativity = () => 3;
  g.calculateRallyScore = () => 100;
  g.calculateRallyGrade = () => 90;
  g.webauthn = { mountPasskeysPanel: vi.fn(() => ({ reload: vi.fn() })) };

  window.GM_BADGES = {
    computeBadges: vi.fn(() => ({
      earned: 1, total: 1,
      categories: [{ key: 'power', label: 'Power', icon: 'ph-lightning', color: '#ffe088', badges: [
        { category: 'power', earned: true, current: 80000000, target: 100000000, progress: 100, color: '#ffe088', icon: 'ph-lightning', name: 'High Power', desc: 'Reach 100M power' }
      ] }]
    }))
  };
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
  delete window.GM_BADGES;
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
    expect(window.GM_BADGES.computeBadges).toHaveBeenCalled();
    expect(document.getElementById('portal-badges-body').textContent).toContain('High Power');

    clickNav('events');
    expect(document.getElementById('portal-panel-events').textContent).toContain('GvG');

    clickNav('absence');
    await tick();
    expect(document.getElementById('portal-absence-body').textContent).toContain('Declare a period');
  });
});

describe('PortalView — chart delegation & cleanup', () => {
  it('delegates chart drawing to window.GM.drawScoreTrendChart', async () => {
    FIXTURES['get-history'] = {
      ok: true,
      events: { 'SvS': { has_score: true, history: [{ week_start: '2026-08-03', score: 100 }] } }
    };
    const view = newView();
    await view.loadDashboard();

    expect(root().querySelector('.portal-chart-canvas')).toBeTruthy();
    expect(window.GM.drawScoreTrendChart).toHaveBeenCalled();
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
