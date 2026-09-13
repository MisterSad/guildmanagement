/**
 * tests/events_view.test.js
 *
 * Phase 1 behavioural suite for src/modules/events/views/EventsView.ts in
 * jsdom. The legacy root `events.js` is untouched during Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventsView } from '../src/modules/events/views/EventsView';
import { resetSupabaseClient } from '../src/core/api/supabase';

const SESSION = 'SVS-2026-W32';

let rpcMock;
let runInChunksMock;

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
    in: (field, list) => { filters.push((r) => list.indexOf(r[field]) !== -1); return chain; },
    update: () => chain,
    delete: () => chain,
    upsert: () => chain,
    maybeSingle: () => ({ then: (resolve) => Promise.resolve({ data: apply()[0] || null, error: null }).then(resolve) }),
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve)
  };
  return chain;
}

function tables(active) {
  return {
    event_status: active
      ? [{ event_name: 'SvS', guild: 'ALPHA', is_active: true, session_id: SESSION, stage: null, start_at: '2026-08-02' }]
      : [{ event_name: 'GvG', guild: 'ALPHA', is_active: false, session_id: null, stage: null, start_at: null }],
    event_participants: [
      { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'SvS', session_id: SESSION, participated: 1, score_prep: 10, score_pvp: 5, is_pending: true, appointed: false },
      { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'SvS', session_id: SESSION, participated: 0, score_prep: 0, score_pvp: 0, is_pending: true, appointed: false }
    ],
    guild_members: [
      { pseudo: 'Alpha', guild: 'ALPHA', uid: 'u1' },
      { pseudo: 'Bravo', guild: 'ALPHA', uid: 'u2' }
    ]
  };
}

let currentTables;

function installDb() {
  rpcMock = vi.fn(async (name) => {
    if (name === 'gm_approve_participant_submission') return { data: { ok: true }, error: null };
    return { data: 0, error: null };
  });
  window.GM.db = { from: (table) => chained(currentTables[table] || []), rpc: rpcMock };
}

function installGM() {
  runInChunksMock = vi.fn(async (items, size, worker) => {
    for (const it of items) await worker(it);
  });
  window.GM = {
    t: (k) => k,
    escapeHTML: (s) => String(s ?? ''),
    formatNumber: (n) => String(n ?? ''),
    getActiveGuild: () => 'ALPHA',
    getWeekStart: () => '2026-08-03',
    buildEventSessionId: () => SESSION,
    parseNumber: (v) => parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 0,
    attachNumberFormatter: vi.fn(),
    avatarInit: (s) => String(s || '').slice(0, 1).toUpperCase(),
    formatDateTimeUTC: (v) => String(v),
    showToast: vi.fn(),
    notifyDiscordEvent: vi.fn(),
    pickEventStart: vi.fn(),
    runInChunks: runInChunksMock,
    db: null
  };
  window.showConfirm = vi.fn();
}

function panel(id) {
  const metric = id === 'event-svs' ? 'svs' : id === 'event-gvg' ? 'gvg' : '';
  const ocrBtns = metric
    ? '<div class="gm-event-ocr-toolbar">' +
        '<button type="button" class="btn-ocr-trigger" data-metric="' + metric + '_prep">' + metric + '_prep OCR</button>' +
        '<button type="button" class="btn-ocr-trigger" data-metric="' + metric + '_pvp">' + metric + '_pvp OCR</button>' +
      '</div>'
    : '';
  return (
    '<main id="' + id + '">' +
      '<div class="event-status-badge"></div>' +
      '<div class="gm-event-actions"></div>' +
      '<div class="gm-event-status-line"></div>' +
      ocrBtns +
      '<div class="war-banner"></div>' +
      '<div class="event-participants-area"></div>' +
    '</main>'
  );
}

function mount() {
  document.body.innerHTML = panel('event-svs') + panel('event-gvg') + panel('event-dtr');
}

function area(id) {
  return document.querySelector('#' + id + ' .event-participants-area');
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetSupabaseClient();
  mount();
  currentTables = tables(true);
  installGM();
  installDb();
});

afterEach(() => {
  vi.useRealTimers();
  delete window.GM;
  delete window.showConfirm;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('EventsView.loadEvent()', () => {
  it('renders the active SvS session participants and stats', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    expect(document.querySelector('#event-svs .event-status-badge').className).toContain('active');
    const rows = area('event-svs').querySelectorAll('.participant-row');
    expect(rows.length).toBe(2);
    expect(area('event-svs').textContent).toContain('event_total');
    // populate RPC issued to self-heal the session.
    expect(rpcMock).toHaveBeenCalledWith('gm_populate_event_participants', expect.objectContaining({ p_session_id: SESSION }));
  });

  it('renders the inactive placeholder when no session is active', async () => {
    const view = new EventsView();
    await view.loadEvent('GvG');
    expect(area('event-gvg').textContent).toContain('event_not_active');
    expect(area('event-gvg').querySelectorAll('.participant-row').length).toBe(0);
  });
});

describe('EventsView — member sync & approval', () => {
  it('adds and removes a member from the active session in memory', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');
    expect(area('event-svs').querySelectorAll('.participant-row').length).toBe(2);

    const added = await view.addMemberToActiveEvents('Charlie');
    expect(added).toBe(1);
    expect(area('event-svs').querySelectorAll('.participant-row').length).toBe(3);

    view.removeMemberFromActiveEvents('Charlie');
    expect(area('event-svs').querySelectorAll('.participant-row').length).toBe(2);
  });

  it('batches "Approve All" via GM.runInChunks(pendingPseudos, 10, ...)', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const approveAll = area('event-svs').querySelector('.approve-all-btn');
    expect(approveAll).toBeTruthy();
    approveAll.click();
    await tick();

    expect(runInChunksMock).toHaveBeenCalledTimes(1);
    const [items, size] = runInChunksMock.mock.calls[0];
    expect(size).toBe(10);
    expect(items.sort()).toEqual(['Alpha', 'Bravo']);

    const approveCalls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_approve_participant_submission');
    expect(approveCalls.length).toBe(2);
  });

  it('approves a single pending submission', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    area('event-svs').querySelector('.approve-single-btn').click();
    await tick();

    expect(rpcMock).toHaveBeenCalledWith('gm_approve_participant_submission', expect.objectContaining({ p_pseudo: 'Alpha' }));
  });
});

describe('EventsView — cutover guard', () => {
  it('does not expose window.GM_EVENTS', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');
    expect(window.GM_EVENTS).toBeUndefined();
  });
});

describe('EventsView — granular war mode', () => {
  it('renders the per-day grid for an active SvS session', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const prepInputs = area('event-svs').querySelectorAll('.score-input-prep');
    expect(prepInputs.length).toBe(0);
    // 2 participants × 6 days.
    expect(area('event-svs').querySelectorAll('.day-score-input').length).toBe(12);
    // Chest cells + opponent banner exist.
    expect(area('event-svs').querySelectorAll('.player-chests-cell').length).toBe(2);
    expect(document.querySelectorAll('#event-svs .war-opponent-input').length).toBe(1);
    expect(document.querySelectorAll('#event-svs .war-day-toggle').length).toBe(6);
  });

  it('falls back to the legacy dual-score table when not granular', async () => {
    currentTables.event_status = [{ event_name: 'SvS', guild: 'ALPHA', is_active: false, session_id: null, stage: null, start_at: null }];
    const view = new EventsView();
    await view.loadEvent('SvS');
    expect(area('event-svs').textContent).toContain('event_not_active');
    expect(area('event-svs').querySelectorAll('.day-score-input').length).toBe(0);
  });

  it('persists per-day scores through gm_upsert_daily_scores after debounce', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const day1 = area('event-svs').querySelector('.day-score-input[data-pseudo="Alpha"][data-day="1"]');
    day1.value = '2500';
    day1.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 800));

    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_daily_scores');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toEqual(expect.objectContaining({
      p_guild: 'ALPHA',
      p_event_name: 'SvS',
      p_session_id: SESSION,
      p_rows: expect.arrayContaining([
        expect.objectContaining({ pseudo: 'Alpha', day: 1, score: 2500 })
      ])
    }));
  });

  it('forwards day scores above 500M unchanged up to 9,999,999,999', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const day6 = area('event-svs').querySelector('.day-score-input[data-pseudo="Alpha"][data-day="6"]');
    day6.value = '9999999999';
    day6.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 800));

    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_daily_scores');
    expect(calls.length).toBe(1);
    expect(calls[0][1].p_rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ pseudo: 'Alpha', day: 6, score: 9999999999 })
    ]));
  });

  it('creates/updates the war opponent through gm_upsert_war_session', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const input = document.querySelector('#event-svs .war-opponent-input');
    input.value = '412';
    input.dispatchEvent(new Event('change'));
    await tick();

    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_war_session');
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1][1];
    expect(last).toEqual(expect.objectContaining({
      p_event_name: 'SvS',
      p_session_id: SESSION,
      p_opponent: expect.objectContaining({ kind: 'server', name: '412' })
    }));
  });

  it('cycles and saves the Day Won/Lost state through gm_upsert_war_session', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const day1 = document.querySelector('#event-svs .war-day-toggle[data-day="1"]');
    day1.click();
    await tick();

    const calls = rpcMock.mock.calls.filter((c) => c[0] === 'gm_upsert_war_session');
    const last = calls[calls.length - 1][1];
    expect(last).toEqual(expect.objectContaining({ p_daily_results: { day1: 'won' } }));
    expect(day1.className).toContain('war-day-won');
  });

  it('keeps every SvS/GvG OCR button clickable in granular mode', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const prep = document.querySelector('#event-svs .btn-ocr-trigger[data-metric="svs_prep"]');
    const pvp = document.querySelector('#event-svs .btn-ocr-trigger[data-metric="svs_pvp"]');
    expect(prep.disabled).toBe(false);
    expect(pvp.disabled).toBe(false);
    expect(prep.getAttribute('data-tooltip')).toBeNull();
  });

  it('keeps the OCR buttons clickable across sessions (GvG active, SvS inactive)', async () => {
    currentTables.event_status = [{ event_name: 'GvG', guild: 'ALPHA', is_active: true, session_id: SESSION, stage: null, start_at: '2026-08-02' }];
    currentTables.event_participants = [
      { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'GvG', session_id: SESSION, participated: 1, score_prep: 10, score_pvp: 5, is_pending: false, appointed: false }
    ];
    const view = new EventsView();
    await view.loadEvent('GvG');

    const prep = document.querySelector('#event-gvg .btn-ocr-trigger[data-metric="gvg_prep"]');
    expect(prep.disabled).toBe(false);

    // Switching to an inactive SvS session keeps that panel's buttons usable.
    currentTables.event_status = [{ event_name: 'SvS', guild: 'ALPHA', is_active: false, session_id: null, stage: null, start_at: null }];
    await view.loadEvent('SvS');
    const svsPrep = document.querySelector('#event-svs .btn-ocr-trigger[data-metric="svs_prep"]');
    expect(svsPrep.disabled).toBe(false);
  });
});
