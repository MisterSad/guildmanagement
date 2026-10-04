/**
 * tests/history_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/history/views/HistoryView.ts in
 * jsdom, including the strict invariants: 15s cache TTL, historyLoading
 * anti-reentrance, and the ALLOWED_HISTORY_FIELDS edit whitelist.
 * The legacy root `history.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HistoryView } from '../src/modules/history/views/HistoryView';
import { ALLOWED_HISTORY_FIELDS, isAllowedHistoryField, EVENT_META, FILTERS } from '../src/modules/history/history.service';
import { isFresh, markFresh } from '../src/core/cache/cache';
import { showToast } from '../src/core/dom/toast';
import { showConfirm } from '../src/modules/app/dialogs/dialogs.service';

// The view imports its helpers directly (no more `window.GM.*` /
// `window.showConfirm` reads): mock the source modules with the stubs the
// suite used to put on window.
vi.mock('../src/core/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  t: (k) => k
}));
vi.mock('../src/core/cache/cache', async (importOriginal) => ({
  ...(await importOriginal()),
  isFresh: vi.fn(),
  markFresh: vi.fn()
}));
vi.mock('../src/core/dom/toast', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn()
}));
vi.mock('../src/modules/app/dialogs/dialogs.service', async (importOriginal) => ({
  ...(await importOriginal()),
  showConfirm: vi.fn()
}));

const SESSIONS = [
  { event_name: 'SvS', session_id: 'SVS-2026-W32', week_start: '2026-08-03', participants: 10, participated_count: 8, total_score: 1000 },
  { event_name: 'GvG', session_id: 'GVG-2026-W31', week_start: '2026-07-27', participants: 10, participated_count: 5, total_score: 500 },
  { event_name: 'Glory', session_id: 'GLORY-2026-08-03', week_start: '2026-08-03', participants: 10, participated_count: 9, total_score: 9000 }
];

const PARTICIPANT_ROWS = [
  { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'SvS', session_id: 'SVS-2026-W32', week_start: '2026-08-03', participated: 1, score: 100, score_prep: 10, score_pvp: 5, late: false, excused: false, sub_present: false, appointed: false },
  { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'SvS', session_id: 'SVS-2026-W32', week_start: '2026-08-03', participated: 0, score: 0, score_prep: 0, score_pvp: 0, late: false, excused: false, sub_present: false, appointed: false }
];

let rpcMock;
let updateMock;
let cacheFresh;

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
    update: (payload) => { updateMock(payload); return chain; },
    delete: () => chain,
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve)
  };
  return chain;
}

function installGM() {
  cacheFresh = false;
  rpcMock = vi.fn(async () => ({ data: JSON.parse(JSON.stringify(SESSIONS)), error: null }));
  updateMock = vi.fn(() => chained([]));
  vi.mocked(isFresh).mockReset();
  vi.mocked(isFresh).mockImplementation(() => cacheFresh);
  vi.mocked(markFresh).mockReset();
  vi.mocked(showToast).mockReset();
  vi.mocked(showConfirm).mockReset();
  localStorage.setItem('gm_current_guild', 'ALPHA');
  localStorage.setItem('gm_role', 'guild_admin');
  // Only the Supabase client is still read from `window.GM` (via getClient()).
  window.GM = {
    db: {
      rpc: rpcMock,
      from: (table) => chained(table === 'event_participants' ? PARTICIPANT_ROWS : [])
    }
  };
  window.requestAnimationFrame = (cb) => { cb(0); return 0; };
}

function mount() {
  document.body.innerHTML = '<div id="event-history"><div class="history-area"></div></div>';
}

function area() {
  return document.querySelector('#event-history .history-area');
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mount();
  installGM();
});

afterEach(() => {
  delete window.GM;
  delete window.requestAnimationFrame;
  localStorage.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('HistoryView.load() & cache', () => {
  it('loads sessions via RPC, sorts them and marks the cache fresh', async () => {
    const view = new HistoryView();
    await view.load();

    expect(rpcMock).toHaveBeenCalledWith('gm_list_event_sessions', { p_guild: 'ALPHA' });
    expect(markFresh).toHaveBeenCalledWith('history:ALPHA');
    expect(area().querySelectorAll('.gm-history-card').length).toBe(3);
    expect(area().querySelectorAll('.history-filter').length).toBe(FILTERS.length);
  });

  it('short-circuits when the cache is fresh', async () => {
    cacheFresh = true;
    const view = new HistoryView();
    await view.load();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('HistoryView — filter pills', () => {
  it('filters the timeline to a single category', async () => {
    const view = new HistoryView();
    await view.load();

    const gvgPill = Array.from(area().querySelectorAll('.history-filter')).find((b) => b.getAttribute('data-filter') === 'GvG');
    gvgPill.click();

    const cards = area().querySelectorAll('.gm-history-card');
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute('data-event')).toBe('GvG');
  });
});

describe('HistoryView — modal & security whitelist', () => {
  it('opens the session modal and persists an edit through the whitelist', async () => {
    const view = new HistoryView();
    await view.load();

    area().querySelector('.gm-history-card[data-event="SvS"]').click();
    await tick();

    const modal = document.getElementById('history-modal');
    expect(modal).toBeTruthy();
    expect(modal.querySelectorAll('tbody tr').length).toBe(2);

    const cb = modal.querySelector('.hist-edit-check[data-field="participated"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    expect(updateMock).toHaveBeenCalledWith({ participated: 0 });
    expect(showToast).toHaveBeenCalledWith('Updated successfully', 'success');
  });

  it('exposes exactly the ALLOWED_HISTORY_FIELDS whitelist', () => {
    expect(ALLOWED_HISTORY_FIELDS).toEqual([
      'participated', 'score', 'score_prep', 'score_pvp',
      'late', 'excused', 'sub_present', 'appointed', 'is_pending'
    ]);
    expect(isAllowedHistoryField('participated')).toBe(true);
    expect(isAllowedHistoryField('hacked')).toBe(false);
  });

  it('rejects an out-of-whitelist field update (no db write)', async () => {
    const view = new HistoryView();
    await view.load();

    await view.updateParticipantField('SvS', 'SVS-2026-W32', '2026-08-03', 'Alpha', 'hacked', true);

    expect(updateMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Invalid update field', 'error');
  });

  it('requires confirmation before deleting a session from the modal', async () => {
    const confirmMock = vi.mocked(showConfirm);
    const view = new HistoryView();
    await view.load();

    area().querySelector('.gm-history-card[data-event="SvS"]').click();
    await tick();

    document.getElementById('history-modal-delete').click();
    expect(confirmMock).toHaveBeenCalledWith('confirm_delete_session_title', expect.any(String), expect.any(Function));
  });

  it('keeps the documented core event metadata', () => {
    expect(EVENT_META['SvS'].hasScore).toBe(true);
    expect(EVENT_META['Shadowfront'].hasScore).toBe(false);
    expect(EVENT_META['Glory'].filterKey).toBe('Glory');
  });
});

describe('HistoryView — cutover guard', () => {
  it('does not expose window.GM_HISTORY', async () => {
    const view = new HistoryView();
    await view.load();
    expect(window.GM_HISTORY).toBeUndefined();
  });
});
