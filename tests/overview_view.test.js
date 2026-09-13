/**
 * tests/overview_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/overview/views/OverviewView.ts in
 * jsdom. The legacy root `overview.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OverviewView } from '../src/modules/overview/views/OverviewView';

const W_CUR = '2026-08-03';
const W_PREV = '2026-07-27';

const TABLES = {
  guild_members: [
    { pseudo: 'Alpha', guild: 'ALPHA', overall_power: 1000000, created_at: '2026-08-01T00:00:00Z', uid: 'u1' },
    { pseudo: 'Bravo', guild: 'ALPHA', overall_power: 500000, created_at: '2026-07-01T00:00:00Z', uid: 'u2' }
  ],
  event_status: [
    { event_name: 'SvS', guild: 'ALPHA', is_active: true, updated_at: '2026-08-02T10:00:00Z', session_id: 'S1', start_at: '2099-01-01T00:00:00Z' }
  ],
  event_participants: [
    { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Glory', week_start: W_CUR, score: 1000 },
    { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Glory', week_start: W_PREV, score: 400 }
  ],
  sanctions: [
    { id: 1, pseudo: 'Bravo', guild: 'ALPHA', comment: 'x', created_by: 'HawkEye', created_at: '2026-08-02T09:00:00Z' }
  ],
  guild_transfers: []
};

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
    eq: (field, val) => { filters.push((r) => r[field] === val); return chain; },
    or: () => chain,
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve)
  };
  return chain;
}

function installDb() {
  window.GM.db = {
    from: (table) => {
      if (table === 'guild_members') {
        return {
          select: (_cols, opts) => {
            if (opts && opts.head) {
              return { eq: () => ({ then: (r) => Promise.resolve({ count: 3, data: null, error: null }).then(r) }) };
            }
            return chained(TABLES.guild_members);
          }
        };
      }
      return chained(TABLES[table] || []);
    }
  };
}

function installGM() {
  window.GM = {
    t: (k) => k,
    escapeHTML: (s) => String(s ?? ''),
    formatNumber: (n) => String(n ?? ''),
    getActiveGuild: () => 'ALPHA',
    getWeekStart: () => W_CUR,
    getPrevWeekStart: () => W_PREV,
    formatDateTimeUTC: (v) => String(v),
    getEventIcon: () => 'ph-swords',
    getEventTheme: () => 'gm-task-card-dark',
    avatarInit: (s) => String(s || '').slice(0, 1).toUpperCase(),
    showToast: vi.fn(),
    renderPendingRegistrations: vi.fn(),
    exportGuildData: vi.fn(async () => ({ ok: true })),
    config: { get: vi.fn(async () => null), set: vi.fn(async () => ({})) },
    db: null
  };
  window.GM_PUSH = { mount: vi.fn() };
}

function mount() {
  document.body.innerHTML = '<main id="gm-overview" class="active"></main>';
}

beforeEach(() => {
  mount();
  installGM();
  installDb();
});

afterEach(() => {
  vi.useRealTimers();
  delete window.GM;
  delete window.GM_PUSH;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('OverviewView.load()', () => {
  it('renders the 4 summary tiles, pending card, activity and push slot', async () => {
    const view = new OverviewView();
    await view.load();

    const panel = document.getElementById('gm-overview');
    expect(panel.querySelectorAll('.gm-stat-tile').length).toBe(4);
    expect(panel.textContent).toContain('Guild Power');
    expect(panel.querySelector('#pending-accounts-card')).toBeTruthy();
    expect(window.GM.renderPendingRegistrations).toHaveBeenCalled();
    expect(window.GM_PUSH.mount).toHaveBeenCalled();
  });

  it('computes "Glory this week" as the weekly gain (1000 - 400 = 600)', async () => {
    const view = new OverviewView();
    await view.load();
    expect(document.getElementById('gm-overview').textContent).toContain('600');
  });

  it('renders the empty timezone-clocks widget when no clocks are configured', async () => {
    const view = new OverviewView();
    await view.load();
    expect(document.getElementById('gm-overview-clocks').textContent).toContain('No timezone clocks yet');
  });
});

describe('OverviewView — tickers & cleanup', () => {
  it('destroy() clears both the countdown and timezone-clock intervals', async () => {
    vi.useFakeTimers();
    const view = new OverviewView();
    await vi.runAllTimersAsync();
    await view.load();

    const spy = vi.spyOn(globalThis, 'clearInterval');
    view.destroy();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('OverviewView — cutover guard', () => {
  it('does not expose window.GM_OVERVIEW', async () => {
    const view = new OverviewView();
    await view.load();
    expect(window.GM_OVERVIEW).toBeUndefined();
  });
});
