/**
 * tests/war_ui_aggregate_mode.test.js
 *
 * Lot 2 UI suite for the SvS / GvG prep entry mode switcher
 * (Detailed D1–D5 vs Cumulative D1–D5):
 *   - war.mode state, segmented control, guild_config persistence;
 *   - aggregate grid layout (Total D1–D5 input on day 0 + Day 6 + chests);
 *   - destructive conversion guard: writing a total over existing D1..D5
 *     opens the confirmation Dialog (cancel reverts, confirm saves);
 *   - reverse conversion (a day D1..D5 over a total) saves directly + toast;
 *   - chest cells and the banner total use prepTotal / resolvePrepChests
 *     (no double counting).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventsView } from '../src/modules/events/views/EventsView';
import { resetSupabaseClient, setDbClient } from '../src/core/api/supabase';
import { showToast } from '../src/core/dom/toast';
import { formatNumber } from '../src/core/utils/text';

const SESSION = 'SVS-2026-W32';

// The view imports its helpers directly (the window bridge is gone): mock the
// source modules with the stubs the suite used to put on window.
vi.mock('../src/core/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  t: (k) => k,
}));
vi.mock('../src/core/config/events', async (importOriginal) => ({
  ...(await importOriginal()),
  buildEventSessionId: () => SESSION,
}));
vi.mock('../src/core/utils/date', async (importOriginal) => ({
  ...(await importOriginal()),
  getWeekStart: () => '2026-08-03',
}));
vi.mock('../src/core/dom/toast', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn(),
}));
vi.mock('../src/core/integrations/discord', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyDiscordEvent: vi.fn(),
}));
vi.mock('../src/modules/app/dialogs/dialogs.service', async (importOriginal) => ({
  ...(await importOriginal()),
  showConfirm: vi.fn(),
}));

let rpcMock;
let dailyRows;

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
    limit: () => chain,
    eq: (field, val) => {
      filters.push((r) => r[field] === val);
      return chain;
    },
    in: (field, list) => {
      filters.push((r) => list.indexOf(r[field]) !== -1);
      return chain;
    },
    update: () => chain,
    delete: () => chain,
    upsert: () => chain,
    maybeSingle: () => ({
      then: (resolve) => Promise.resolve({ data: apply()[0] || null, error: null }).then(resolve),
    }),
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve),
  };
  return chain;
}

function tables() {
  return {
    guild_config: [],
    event_status: [
      { event_name: 'SvS', guild: 'ALPHA', is_active: true, session_id: SESSION, stage: null, start_at: '2026-08-02' },
    ],
    event_participants: [
      {
        pseudo: 'Alpha',
        guild: 'ALPHA',
        event_name: 'SvS',
        session_id: SESSION,
        participated: 1,
        score_prep: 0,
        score_pvp: 0,
        is_pending: false,
        appointed: false,
      },
      {
        pseudo: 'Bravo',
        guild: 'ALPHA',
        event_name: 'SvS',
        session_id: SESSION,
        participated: 0,
        score_prep: 0,
        score_pvp: 0,
        is_pending: false,
        appointed: false,
      },
    ],
    guild_members: [
      { pseudo: 'Alpha', guild: 'ALPHA', uid: 'u1' },
      { pseudo: 'Bravo', guild: 'ALPHA', uid: 'u2' },
    ],
  };
}

let currentTables;

function installDb() {
  rpcMock = vi.fn(async (name) => {
    if (name === 'gm_get_daily_scores') {
      return { data: { ok: true, rows: dailyRows.slice() }, error: null };
    }
    if (name === 'gm_upsert_daily_scores') {
      return { data: { ok: true, updated: 1 }, error: null };
    }
    return { data: 0, error: null };
  });
  setDbClient({ from: (table) => chained(currentTables[table] || []), rpc: rpcMock });
}

function installGM() {
  vi.mocked(showToast).mockReset();
  localStorage.setItem('gm_current_guild', 'ALPHA');
  // The Supabase client is installed with setDbClient() (read via getClient()).
  setDbClient(null);
}

function mount() {
  document.body.innerHTML =
    '<main id="event-svs">' +
    '<div class="event-status-badge"></div>' +
    '<div class="gm-event-actions"></div>' +
    '<div class="gm-event-status-line"></div>' +
    '<div class="gm-event-ocr-toolbar">' +
    '<button type="button" class="btn-ocr-trigger" data-metric="svs_prep">svs_prep OCR</button>' +
    '<button type="button" class="btn-ocr-trigger" data-metric="svs_pvp">svs_pvp OCR</button>' +
    '</div>' +
    '<div class="war-banner"></div>' +
    '<div class="event-participants-area"></div>' +
    '</main>';
}

function area() {
  return document.querySelector('#event-svs .event-participants-area');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetSupabaseClient();
  localStorage.clear();
  mount();
  currentTables = tables();
  dailyRows = [];
  installGM();
  installDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSupabaseClient();
  document.body.innerHTML = '';
});

describe('war prep mode switcher', () => {
  it('renders the detailed six-day grid by default and the aggregate grid after switching', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    // Detailed default: 2 participants × 6 days.
    expect(area().querySelectorAll('.day-score-input').length).toBe(12);
    expect(document.querySelectorAll('#event-svs .day-score-input[data-day="0"]').length).toBe(0);
    expect(area().querySelectorAll('.player-chests-cell').length).toBe(2);

    // Switch to aggregate: 2 participants × (Total D1–D5 + Day 6).
    document.querySelector('#event-svs .war-mode-btn[data-war-mode="aggregate"]').click();
    await wait(10);

    expect(area().querySelectorAll('.day-score-input').length).toBe(4);
    expect(area().querySelectorAll('.day-score-input[data-day="0"]').length).toBe(2);
    expect(area().querySelectorAll('.day-score-input[data-day="6"]').length).toBe(2);
    expect(area().querySelectorAll('.day-score-input[data-day="1"]').length).toBe(0);
    // Headers: the aggregate total column + chests.
    expect(area().querySelector('thead').textContent).toContain('war_col_total_d15');
    expect(area().querySelector('thead').textContent).toContain('war_col_chests');
  });

  it('persists the mode in guild_config and restores it on reload', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    document.querySelector('#event-svs .war-mode-btn[data-war-mode="aggregate"]').click();
    await wait(30);

    expect(localStorage.getItem('gm_config_ALPHA_war_prep_mode:SvS')).toBe('aggregate');

    // A fresh view (same guild) starts in aggregate mode.
    const view2 = new EventsView();
    await view2.loadEvent('SvS');
    expect(area().querySelectorAll('.day-score-input[data-day="0"]').length).toBe(2);
  });

  it('keeps detailed mode when no preference is persisted', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');
    expect(area().querySelectorAll('.day-score-input[data-day="0"]').length).toBe(0);
    expect(area().querySelectorAll('.day-score-input[data-day="1"]').length).toBe(2);
  });
});

describe('war aggregate grid computation', () => {
  it('renders chests from resolvePrepChests (day-0 slice) + Day 6 slice', async () => {
    dailyRows = [
      { day: 0, score: 1000000, chests_unlocked: 2, pseudo: 'Alpha' },
      { day: 6, score: 750000, chests_unlocked: 3, pseudo: 'Alpha' },
    ];
    const view = new EventsView();
    await view.loadEvent('SvS');
    document.querySelector('#event-svs .war-mode-btn[data-war-mode="aggregate"]').click();
    await wait(10);

    const alphaRow = area().querySelector('.participant-row[data-pseudo="Alpha"]');
    // default SvS grid: day 0 tier 2 = 918000, day 6 tier 3 = 700000
    // prep 1000000 → 2 chests ; day 6 750000 → 3 chests ; total 5.
    expect(alphaRow.querySelector('.player-chests-cell').textContent).toBe('5');
    // Inputs carry the persisted aggregate + Day 6 values.
    expect(alphaRow.querySelector('.day-score-input[data-day="0"]').value).toBe(formatNumber(1000000));
    expect(alphaRow.querySelector('.day-score-input[data-day="6"]').value).toBe(formatNumber(750000));
  });

  it('computes the banner total with prepTotal + Day 6 (no double counting)', async () => {
    dailyRows = [
      { day: 0, score: 10000, chests_unlocked: 2, pseudo: 'Alpha' },
      { day: 0, score: 20000, chests_unlocked: 2, pseudo: 'Bravo' },
    ];
    const view = new EventsView();
    await view.loadEvent('SvS');

    // 10000 + 20000 = 30000 (an aggregate score must NOT be counted per day).
    const chip = Array.from(area().querySelectorAll('.event-stats .gm-chip')).find(
      (c) => c.getAttribute('title') === '30 000'
    );
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('30K');
  });

  it('persists the aggregate value through gm_upsert_daily_scores with day 0 after debounce', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');
    document.querySelector('#event-svs .war-mode-btn[data-war-mode="aggregate"]').click();
    await wait(10);

    const total = area().querySelector('.day-score-input[data-pseudo="Alpha"][data-day="0"]');
    total.value = '5500';
    total.dispatchEvent(new Event('input'));
    await wait(800);

    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_daily_scores');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        p_guild: 'ALPHA',
        p_event_name: 'SvS',
        p_session_id: SESSION,
        p_rows: expect.arrayContaining([expect.objectContaining({ pseudo: 'Alpha', day: 0, score: 5500 })]),
      })
    );
  });
});

describe('destructive conversion guard (total over existing D1..D5)', () => {
  it('opens the confirmation dialog and reverts the input when cancelled', async () => {
    dailyRows = [
      { day: 1, score: 2500, chests_unlocked: 1, pseudo: 'Alpha' },
      { day: 2, score: 3000, chests_unlocked: 1, pseudo: 'Alpha' },
    ];
    const view = new EventsView();
    await view.loadEvent('SvS');
    document.querySelector('#event-svs .war-mode-btn[data-war-mode="aggregate"]').click();
    await wait(10);

    const rpcBefore = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_daily_scores').length;
    const total = area().querySelector('.day-score-input[data-pseudo="Alpha"][data-day="0"]');
    total.value = '5500';
    total.dispatchEvent(new Event('input'));
    await wait(800);

    // Confirm dialog is up.
    const dialog = document.querySelector('.gm-ui-dialog-wrap');
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector('.gm-ui-dialog-title').textContent).toBe('war_confirm_total_replaces_days');

    // Cancel: no RPC call, input reverted to its persisted (empty) value.
    dialog.querySelector('.gm-ui-dialog-cancel').click();
    await wait(30);
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_daily_scores').length).toBe(rpcBefore);
    expect(total.value).toBe('');
  });

  it('confirms and saves day 0 with the replacement toast', async () => {
    dailyRows = [
      { day: 1, score: 2500, chests_unlocked: 1, pseudo: 'Alpha' },
      { day: 2, score: 3000, chests_unlocked: 1, pseudo: 'Alpha' },
    ];
    const view = new EventsView();
    await view.loadEvent('SvS');
    document.querySelector('#event-svs .war-mode-btn[data-war-mode="aggregate"]').click();
    await wait(10);

    const total = area().querySelector('.day-score-input[data-pseudo="Alpha"][data-day="0"]');
    total.value = '5500';
    total.dispatchEvent(new Event('input'));
    await wait(800);

    document.querySelector('.gm-ui-dialog-confirm').click();
    await wait(30);

    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_daily_scores');
    expect(calls.length).toBe(1);
    expect(calls[0][1].p_rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ pseudo: 'Alpha', day: 0, score: 5500 })])
    );
    expect(showToast).toHaveBeenCalledWith('war_toast_total_replaced_days', 'success');
  });
});

describe('reverse conversion (day D1..D5 over a total)', () => {
  it('saves directly without a dialog and shows the informative toast', async () => {
    dailyRows = [{ day: 0, score: 5000, chests_unlocked: 2, pseudo: 'Alpha' }];
    const view = new EventsView();
    await view.loadEvent('SvS');
    // Stay in detailed mode: Alpha has an aggregate total, the grid still
    // allows per-day entry which supersedes it (RPC convergence deletes day 0).
    const day1 = area().querySelector('.day-score-input[data-pseudo="Alpha"][data-day="1"]');
    day1.value = '1000';
    day1.dispatchEvent(new Event('input'));
    await wait(800);

    expect(document.querySelector('.gm-ui-dialog-wrap')).toBeNull();
    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_daily_scores');
    expect(calls.length).toBe(1);
    expect(calls[0][1].p_rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ pseudo: 'Alpha', day: 1, score: 1000 })])
    );
    expect(showToast).toHaveBeenCalledWith('war_toast_days_replaced_total', 'info');
  });
});
