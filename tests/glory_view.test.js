/**
 * tests/glory_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/glory/views/GloryView.ts in jsdom.
 * The legacy root `glory.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GloryView } from '../src/modules/glory/views/GloryView';
import { showToast } from '../src/core/dom/toast';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';

// The view imports its helpers directly: mock the source modules with the
// stubs the suite used to put on the (now removed) window bridge.
vi.mock('../src/core/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  t: (k) => k
}));
vi.mock('../src/core/utils/date', async (importOriginal) => ({
  ...(await importOriginal()),
  getWeekStart: () => '2026-08-03',
  getPrevWeekStart: () => '2026-07-27'
}));
vi.mock('../src/core/utils/text', async (importOriginal) => ({
  ...(await importOriginal()),
  formatNumber: (n) => String(n ?? '')
}));
vi.mock('../src/core/dom/toast', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn()
}));

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

function installDb(tables) {
  rpcMock = vi.fn(async () => ({ data: [{ ok: true }], error: null }));
  localStorage.setItem('gm_current_guild', 'ALPHA');
  // The view reads the Supabase client through getClient().
  setDbClient({ from: (table) => chained(tables[table] || []), rpc: rpcMock });
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
  vi.mocked(showToast).mockClear();
  mount();
  installDb(JSON.parse(JSON.stringify(TABLES)));
});

afterEach(() => {
  vi.useRealTimers();
  resetSupabaseClient();
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
    installDb({ guild_members: [], event_participants: [] });
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

  // The old title ended "then refreshes members": the view called
  // the bridge's fetchGuildMembers(), which only this suite ever defined -- in the
  // app it was a no-op, and the call is gone.
  it('debounces and upserts via gm_upsert_player_glory', async () => {
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

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('permission_denied'), 'error');
  });
});

describe('GloryView — cutover guard', () => {
  it('does not expose a GM_GLORY global on window', async () => {
    const view = new GloryView();
    await view.load();
    expect(Object.getOwnPropertyNames(window)).not.toContain('GM_GLORY');
  });
});
