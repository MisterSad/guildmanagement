/**
 * tests/glory_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/glory/views/GloryView.ts in jsdom.
 * The legacy root `glory.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GloryView } from '../src/modules/glory/views/GloryView';

let rpcMock;

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
    is: (field, val) => { filters.push((r) => r[field] === val); return chain; },
    in: (field, list) => { filters.push((r) => list.indexOf(r[field]) !== -1); return chain; },
    update: () => chain,
    delete: () => chain,
    maybeSingle: () => ({ then: (resolve) => Promise.resolve({ data: apply()[0] || null, error: null }).then(resolve) }),
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve)
  };
  return chain;
}

function installGM(tables) {
  rpcMock = vi.fn(async () => ({ data: [{ ok: true }], error: null }));
  window.GM = {
    t: (k) => k,
    escapeHTML: (s) => String(s ?? ''),
    formatNumber: (n) => String(n ?? ''),
    getWeekStart: () => '2026-08-03',
    getPrevWeekStart: () => '2026-07-27',
    getActiveGuild: () => 'ALPHA',
    avatarInit: (s) => String(s || '').slice(0, 1).toUpperCase(),
    attachNumberFormatter: vi.fn(),
    parseNumber: (v) => parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 0,
    showToast: vi.fn(),
    fetchGuildMembers: vi.fn(),
    db: { from: (table) => chained(tables[table] || []), rpc: rpcMock }
  };
}

function mount() {
  document.body.innerHTML = '<div id="event-glory"><div class="event-participants-area"></div></div>';
}

function area() {
  return document.querySelector('#event-glory .event-participants-area');
}

const TABLES = {
  guild_members: [
    { pseudo: 'Alpha', guild: 'ALPHA' },
    { pseudo: 'Bravo', guild: 'ALPHA' }
  ],
  event_participants: [
    { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Glory', week_start: '2026-08-03', score: 5000 },
    { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'Glory', week_start: '2026-08-03', score: 0 },
    { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'Glory', week_start: '2026-07-27', score: 4000 },
    { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'Glory', week_start: '2026-07-27', score: 1000 }
  ]
};

beforeEach(() => {
  mount();
  installGM(JSON.parse(JSON.stringify(TABLES)));
});

afterEach(() => {
  vi.useRealTimers();
  delete window.GM;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('GloryView.load()', () => {
  it('renders the member log, guild total and evolution badge', async () => {
    const view = new GloryView();
    await view.load();

    const rows = area().querySelectorAll('.participant-row');
    expect(rows.length).toBe(2);
    // sorted by previous-week glory desc: Alpha (4000) then Bravo (1000)
    expect(rows[0].getAttribute('data-pseudo')).toBe('Alpha');
    expect(area().querySelector('.total-glory-val').textContent).toBe('5000');
    // Alpha 5000 vs 4000 => +25.0%
    expect(area().querySelector('.glory-pct-cell').textContent).toContain('+25.0%');
  });

  it('renders the empty state without members', async () => {
    installGM({ guild_members: [], event_participants: [] });
    const view = new GloryView();
    await view.load();
    expect(area().innerHTML).toContain('gm-empty-title');
    expect(area().textContent).toContain('empty_members');
  });
});

describe('GloryView — search & save', () => {
  it('filters rows by pseudo', async () => {
    const view = new GloryView();
    await view.load();

    const input = area().querySelector('.glory-search-input');
    input.value = 'bravo';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const rows = area().querySelectorAll('.participant-row');
    expect(rows[0].style.display).toBe('none');   // Alpha hidden
    expect(rows[1].style.display).toBe('');       // Bravo shown
  });

  it('debounces and upserts via gm_upsert_player_glory, then refreshes members', async () => {
    vi.useFakeTimers();
    const view = new GloryView();
    await view.load();

    const alphaInput = area().querySelector('.glory-input[data-pseudo="Alpha"]');
    alphaInput.value = '6000';
    alphaInput.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(700);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('gm_upsert_player_glory', {
      p_guild: 'ALPHA',
      p_pseudo: 'Alpha',
      p_week_start: '2026-08-03',
      p_glory: 6000
    });
    expect(window.GM.fetchGuildMembers).toHaveBeenCalled();
  });

  it('surfaces an RPC logical failure as a toast', async () => {
    vi.useFakeTimers();
    const view = new GloryView();
    await view.load();
    rpcMock.mockResolvedValueOnce({ data: [{ ok: false, error: 'permission_denied' }], error: null });

    const alphaInput = area().querySelector('.glory-input[data-pseudo="Alpha"]');
    alphaInput.value = '1';
    alphaInput.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);

    expect(window.GM.showToast).toHaveBeenCalledWith(expect.stringContaining('permission_denied'), 'error');
  });
});

describe('GloryView — cutover guard', () => {
  it('does not expose window.GM_GLORY', async () => {
    const view = new GloryView();
    await view.load();
    expect(window.GM_GLORY).toBeUndefined();
  });
});
