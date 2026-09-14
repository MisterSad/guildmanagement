/**
 * tests/ui_components_p2.test.js
 *
 * Priority-2 modular components (Badge / Table) + the granular war view
 * retrofit contract:
 * - cva tone/style/size propagation and escaping (Badge)
 * - renderWarStatusBadge W/L/tie/pending mapping
 * - Table wrapper: sticky header classes, empty/loading role=status states,
 *   alignment, row highlight + row keys
 * - compact large-score formatting (formatCompactNumber)
 * - EventsView granular grid now consumes the Badge/Table primitives while
 *   keeping the existing markup contracts (.war-day-toggle, .player-chests-cell,
 *   .day-score-input, resolveChestsForScore untouched)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventsView } from '../src/modules/events/views/EventsView';
import { resetSupabaseClient } from '../src/core/api/supabase';

import { renderBadge, createBadge, renderWarStatusBadge, badgeRecipe } from '../src/components/ui/Badge';
import {
  renderTable,
  createTable,
  renderTableHead,
  renderTableCell,
  renderTableEmpty,
  renderTableLoading,
  tableClass
} from '../src/components/ui/Table';
import { formatCompactNumber } from '../src/core/utils/numbers';

/* ─── Badge unit coverage ──────────────────────────────────────────────── */
describe('Badge — cva recipe, escaping, helpers', () => {
  it('exports a cva recipe with tone/style/size defaults', () => {
    expect(badgeRecipe({})).toContain('gm-ui-badge');
    expect(badgeRecipe({})).toContain('gm-ui-badge-default');
    expect(badgeRecipe({})).toContain('gm-ui-badge-soft');
    expect(badgeRecipe({})).toContain('gm-ui-badge-md');
    expect(badgeRecipe({ tone: 'svs', style: 'pill', size: 'sm' })).toContain('gm-ui-badge-svs');
    expect(badgeRecipe({ tone: 'svs', style: 'pill', size: 'sm' })).toContain('gm-ui-badge-pill');
    expect(badgeRecipe({ tone: 'success', style: 'solid' })).toContain('gm-ui-badge-success');
  });

  it('renders an accessible span with escaped text and title tooltip', () => {
    const html = renderBadge({ text: 'Won <b>Day</b>', tone: 'success', title: '9 999 999 999' });
    expect(html).toMatch(/^<span class="gm-ui-badge[^"]*" title="9 999 999 999">/);
    expect(html).toContain('gm-ui-badge-success');
    expect(html).toContain('&lt;b&gt;Day&lt;/b&gt;');
  });

  it('createBadge returns a span element', () => {
    const el = createBadge({ text: 'T1', tone: 'svs', style: 'soft', size: 'sm' });
    expect(el).toBeInstanceOf(HTMLSpanElement);
    expect(el.className).toContain('gm-ui-badge-svs');
    expect(el.textContent).toBe('T1');
  });

  it('renderWarStatusBadge maps W/L/tie/pending to tone + compact marker', () => {
    expect(renderWarStatusBadge('W')).toContain('gm-ui-badge-success');
    expect(renderWarStatusBadge('W')).toContain('>W<');
    expect(renderWarStatusBadge('L')).toContain('gm-ui-badge-danger');
    expect(renderWarStatusBadge('tie')).toContain('gm-ui-badge-default');
    expect(renderWarStatusBadge('pending')).toContain('gm-ui-badge-warning');
  });

  it('renderWarStatusBadge uses i18n-resolved labels when provided', () => {
    const html = renderWarStatusBadge('W', { won: 'Won', lost: 'Lost', pending: 'Pending' });
    expect(html).toContain('>Won<');
    expect(html).toContain('gm-ui-badge-success');
  });
});

/* ─── Table wrapper coverage ───────────────────────────────────────────── */
describe('Table — renderTable contract', () => {
  const cols = [
    { key: 'pseudo', label: 'Member', align: 'left' },
    { key: 'd1', label: 'Day 1', align: 'right' },
    { key: 'chests', label: 'Chests', align: 'center' }
  ];

  it('renders the wrapped table shell with sticky/responsive classes', () => {
    const html = renderTable({ columns: cols, rows: [], sticky: true, responsive: true });
    expect(html).toContain('gm-table-wrap gm-ui-table-wrap');
    expect(html).toContain('gm-table-scroll');
    expect(html).toContain('gm-table gm-ui-table-el gm-resp-table gm-ui-table-sticky');
  });

  it('renders escaped headers with alignment classes', () => {
    const html = renderTable({ columns: cols, rows: [], wrapped: false });
    expect(html).toContain('Member');
    expect(html).toContain('gm-right');
    expect(html).toContain('gm-center');
  });

  it('renders row cells with escaping, alignment and custom overrides', () => {
    const html = renderTable({
      columns: cols,
      rows: [{ pseudo: '<Alpha>', d1: 2500, chests: 4 }],
      wrapped: false
    });
    expect(html).toContain('&lt;Alpha&gt;');
    expect(html).toContain('>2500<');
    expect(html).toContain('>4<');
  });

  it('applies rowClass, highlight and rowKey onto <tr>', () => {
    const html = renderTable({
      columns: cols,
      rows: [{ pseudo: 'Alpha', d1: 2500, chests: 1 }],
      wrapped: false,
      rowClass: (row) => (row.pseudo === 'Alpha' ? 'participant-row' : ''),
      highlight: (row) => (row.d1 >= 1000 ? 'gm-ui-table-hl-target' : null),
      rowKey: (row) => row.pseudo
    });
    expect(html).toContain('class="gm-ui-table-row participant-row gm-ui-table-hl-target"');
    expect(html).toContain('data-state="gm-ui-table-hl-target"');
    expect(html).toContain('data-row-key="Alpha"');
  });

  it('renders an accessible empty state (role=status)', () => {
    const html = renderTable({ columns: cols, rows: [], wrapped: false, emptyText: 'No war session' });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('No war session');
    expect(html).toContain('gm-ui-table-empty-row');
  });

  it('renders an accessible loading state (role=status + aria-busy)', () => {
    const html = renderTable({ columns: cols, rows: [], wrapped: false, loading: true, loadingText: 'Loading grid' });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading grid');
    expect(html).toContain('gm-ui-table-loading-row');
  });

  it('createTable mounts into a host and returns the table element', () => {
    const host = document.createElement('div');
    const table = createTable(host, { columns: cols, rows: [{ pseudo: 'X', d1: 1, chests: 2 }] });
    expect(table).toBeInstanceOf(HTMLTableElement);
    expect(host.querySelectorAll('tr').length).toBe(2);
  });
});

describe('Table — granular composition helpers', () => {
  it('tableClass merges sticky + responsive', () => {
    expect(tableClass({ sticky: true, responsive: true })).toContain('gm-ui-table-sticky');
    expect(tableClass({ sticky: false, responsive: false })).not.toContain('gm-ui-table-sticky');
  });

  it('renderTableHead emits escaped aligned th', () => {
    const head = renderTableHead([{ key: 'd', label: '<Day>', align: 'right' }]);
    expect(head).toContain('&lt;Day&gt;');
    expect(head).toContain('gm-right');
  });

  it('renderTableCell keeps alignment + optional data-label', () => {
    expect(renderTableCell('25', 'right', 'Day 1')).toContain('class="gm-ui-table-td gm-right"');
    expect(renderTableCell('25', 'right', 'Day 1')).toContain('data-label="Day 1"');
  });

  it('empty/loading rows carry role=status', () => {
    expect(renderTableEmpty(3, 'none')).toContain('role="status"');
    expect(renderTableLoading(3)).toContain('role="status"');
  });
});

/* ─── Compact score formatting ─────────────────────────────────────────── */
describe('formatCompactNumber — large score display', () => {
  it('passes small numbers through ungrouped', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('shortens thousands to K (down-rounded)', () => {
    expect(formatCompactNumber(1500)).toBe('1.5K');
    expect(formatCompactNumber(2000)).toBe('2K');
    expect(formatCompactNumber(999_999)).toBe('999.9K');
  });

  it('shortens millions to M', () => {
    expect(formatCompactNumber(1_234_567)).toBe('1.2M');
    expect(formatCompactNumber(2_000_000)).toBe('2M');
  });

  it('shortens billions to B up to 9,999,999,999', () => {
    expect(formatCompactNumber(1_500_000_000)).toBe('1.5B');
    expect(formatCompactNumber(9_999_999_999)).toBe('9.9B');
  });

  it('accepts string input and strips separators', () => {
    expect(formatCompactNumber('9 999 999 999')).toBe('9.9B');
  });
});

/* ─── EventsView granular retrofit (integration) ───────────────────────── */
const SESSION = 'SVS-2026-W32';

function chained(value) {
  const filters = [];
  const apply = () => {
    let res = (value || []).slice();
    filters.forEach((f) => { res = res.filter(f); });
    return res;
  };
  const chain = {
    select: () => chain, order: () => chain, limit: () => chain,
    eq: (field, val) => { filters.push((r) => r[field] === val); return chain; },
    in: (field, list) => { filters.push((r) => list.indexOf(r[field]) !== -1); return chain; },
    update: () => chain, delete: () => chain, upsert: () => chain,
    maybeSingle: () => ({ then: (resolve) => Promise.resolve({ data: apply()[0] || null, error: null }).then(resolve) }),
    then: (resolve) => Promise.resolve({ data: apply(), error: null }).then(resolve)
  };
  return chain;
}

function tables() {
  return {
    event_status: [{ event_name: 'SvS', guild: 'ALPHA', is_active: true, session_id: SESSION, stage: null, start_at: '2026-08-02' }],
    event_participants: [
      { pseudo: 'Alpha', guild: 'ALPHA', event_name: 'SvS', session_id: SESSION, participated: 1, score_prep: 10, score_pvp: 5, is_pending: false, appointed: false },
      { pseudo: 'Bravo', guild: 'ALPHA', event_name: 'SvS', session_id: SESSION, participated: 1, score_prep: 10, score_pvp: 5, is_pending: false, appointed: false }
    ],
    guild_members: [
      { pseudo: 'Alpha', guild: 'ALPHA', uid: 'u1' },
      { pseudo: 'Bravo', guild: 'ALPHA', uid: 'u2' }
    ]
  };
}

let rpcMock;
let currentTables;
let view;

function installGM() {
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
    runInChunks: vi.fn(async (items, size, worker) => { for (const it of items) await worker(it); }),
    db: null
  };
  window.showConfirm = vi.fn();
}

function installDb(overrides) {
  rpcMock = vi.fn(async (name, params) => {
    if (overrides && overrides[name]) return overrides[name](params);
    if (name === 'gm_approve_participant_submission') return { data: { ok: true }, error: null };
    if (name === 'gm_get_daily_scores') {
      return { data: { ok: true, rows: [
        { pseudo: 'Alpha', day: 1, score: 1500, chests_unlocked: 1 },
        { pseudo: 'Alpha', day: 2, score: 2500, chests_unlocked: 2 },
        { pseudo: 'Bravo', day: 1, score: 899_999_999, chests_unlocked: 3 }
      ] }, error: null };
    }
    if (name === 'gm_get_war_session') {
      return { data: { ok: true, session: {
        guild: 'ALPHA', event_name: 'SvS', session_id: SESSION,
        day1_result: 'won', day2_result: 'lost',
        opponent_snapshot: { name: '412', kind: 'server' },
        chest_tiers_snapshot: []
      } }, error: null };
    }
    return { data: 0, error: null };
  });
  window.GM.db = { from: (table) => chained(currentTables[table] || []), rpc: rpcMock };
}

function mount() {
  const panel = (id, metric) =>
    '<main id="' + id + '"><div class="event-status-badge"></div><div class="gm-event-actions"></div>' +
    '<div class="gm-event-status-line"></div>' +
    '<div class="gm-event-ocr-toolbar">' +
      '<button type="button" class="btn-ocr-trigger" data-metric="' + metric + '_prep"></button>' +
      '<button type="button" class="btn-ocr-trigger" data-metric="' + metric + '_pvp"></button>' +
    '</div>' +
    '<div class="war-banner"></div><div class="event-participants-area"></div></main>';
  document.body.innerHTML = panel('event-svs', 'svs') + panel('event-gvg', 'gvg') + panel('event-dtr', '');
}

function area(id) {
  return document.querySelector('#' + id + ' .event-participants-area');
}

beforeEach(() => {
  resetSupabaseClient();
  mount();
  currentTables = tables();
  installGM();
  installDb();
  view = new EventsView();
});

afterEach(() => {
  vi.useRealTimers();
  delete window.GM;
  delete window.showConfirm;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('EventsView — granular war retrofit (Badge + Table primitives)', () => {
  it('renders W/L status badges inside the day toggles', async () => {
    await view.loadEvent('SvS');
    const states = document.querySelectorAll('#event-svs .war-day-toggle .war-day-state .gm-ui-badge');
    expect(states.length).toBe(6);
    expect(document.querySelector('#event-svs .war-day-toggle[data-day="1"] .war-day-state .gm-ui-badge').className).toContain('gm-ui-badge-success');
    expect(document.querySelector('#event-svs .war-day-toggle[data-day="2"] .war-day-state .gm-ui-badge').className).toContain('gm-ui-badge-danger');
  });

  it('renders chest totals as glory badges with exact-value title', async () => {
    await view.loadEvent('SvS');
    const cells = area('event-svs').querySelectorAll('.player-chests-cell');
    expect(cells.length).toBe(2);
    const chestBadges = area('event-svs').querySelectorAll('.player-chests-cell .gm-ui-badge.gm-ui-badge-glory');
    expect(chestBadges.length).toBeGreaterThan(0);
    expect(chestBadges[0].getAttribute('title')).toBeTruthy();
  });

  it('keeps the .day-score-input editable grid and business scoring intact', async () => {
    await view.loadEvent('SvS');
    const inputs = area('event-svs').querySelectorAll('.day-score-input');
    expect(inputs.length).toBe(12);
    expect(document.querySelectorAll('#event-svs .war-day-toggle').length).toBe(6);
    // chest cell badge regenerated live from resolveChestsForScore on input.
    const d1 = document.querySelector('#event-svs .day-score-input[data-pseudo="Alpha"][data-day="1"]');
    d1.value = '50000';
    d1.dispatchEvent(new Event('input'));
    const cell = document.querySelector('#event-svs .participant-row[data-pseudo="Alpha"] .player-chests-cell');
    expect(cell.querySelector('.gm-ui-badge')).toBeTruthy();
  });

  it('adopts the modern table shell (sticky + gm-ui-table) for the D1-D6 grid', async () => {
    await view.loadEvent('SvS');
    expect(document.querySelector('#event-svs table.gm-table.gm-ui-table-el.gm-ui-table-sticky')).toBeTruthy();
    expect(document.querySelector('#event-svs .gm-table-wrap.gm-ui-table-wrap')).toBeTruthy();
  });

  it('shows the compact total score with exact-value title tooltip', async () => {
    await view.loadEvent('SvS');
    const chip = document.querySelector('#event-svs .gm-chip.gm-chip-accent');
    expect(chip.getAttribute('title')).toBeTruthy();
    expect(chip.textContent).toContain('event_total_score');
    expect(chip.textContent).toMatch(/\d/);
  });
});