/**
 * tests/war_ocr_granular.test.js
 *
 * Lot 3 — SvS/GvG OCR routing into the daily-score grid:
 *   - all war OCR commits flow through EventsService.upsertDailyScores
 *     (gm_upsert_daily_scores): svs_prep/gvg_prep -> day 0, svs_day/gvg_day
 *     -> validated scanDay, svs_pvp/gvg_pvp -> day 6. No direct
 *     event_participants.score_prep write remains for war metrics.
 *   - the Edge Function MetadataSchema validates scanDay as a strict Zod
 *     integer in [1,6] and substitutes the validated integer (never raw text)
 *     into the day-metric prompt.
 *   - the legacy syncWarOcrGate disabling is fully removed (buttons clickable).
 *   - the OCR modal shows a day selector for svs_day / gvg_day.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { openOcrModal, setOcrMetric, commitOcrUpdates } from '../src/modules/app/ocr/ocr.controller';
import { setOcrExtractedPlayers, getOcrScanDay, setOcrScanDay, getCurrentOcrMetric, OCR_METRICS_META } from '../src/modules/app/ocr/ocr.meta';
import { resetSupabaseClient } from '../src/core/api/supabase';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

const SESSION = 'SVS-2026-W32';

const OCR_DOM = `
  <div id="ocr-modal-overlay" style="display:none">
    <h3 id="ocr-modal-title"></h3><p id="ocr-modal-subtitle"></p>
    <span id="ocr-scope-badge"></span><span id="ocr-scope-desc"></span>
    <div id="ocr-tag-input-group"><input id="ocr-guild-tag-input" /></div>
    <div id="ocr-metric-tabs">
      <button class="gm-seg-btn" data-metric="power"></button>
    </div>
    <div id="ocr-day-selector" style="display:none">
      <div id="ocr-day-buttons">
        <button class="gm-seg-btn" data-ocr-day="1">Day 1</button>
        <button class="gm-seg-btn" data-ocr-day="2">Day 2</button>
        <button class="gm-seg-btn" data-ocr-day="3">Day 3</button>
        <button class="gm-seg-btn" data-ocr-day="4">Day 4</button>
        <button class="gm-seg-btn" data-ocr-day="5">Day 5</button>
      </div>
    </div>
    <div id="ocr-dropzone"><h4 id="ocr-dropzone-title"></h4><p id="ocr-dropzone-desc"></p></div>
    <div id="ocr-loading" style="display:none"><h4></h4><p></p></div>
    <input id="ocr-file-input" type="file" />
    <div id="ocr-results-container" style="display:none">
      <table class="ocr-table"><thead><tr><th id="ocr-metric-header"></th><th id="ocr-rank-header"></th></tr></thead><tbody id="ocr-results-tbody"></tbody></table>
      <table><tbody id="ocr-results-tbody-new"></tbody></table>
      <table><tbody id="ocr-results-tbody-removed"></tbody></table>
    </div>
    <span id="ocr-detected-count">0</span><div id="ocr-summary-badges"></div>
    <input id="ocr-filter-search" />
    <button id="ocr-select-all-btn"></button>
    <button id="ocr-commit-btn"><span></span></button>
    <button id="ocr-modal-close"></button><button id="ocr-modal-cancel"></button>
    <button id="ocr-reset-btn"></button><input id="ocr-toggle-all-cb" type="checkbox" />
  </div>
  <div id="guild-member-list"></div><span id="guild-member-count">0</span>
  <div id="toast-container"></div>
`;

function makeDb() {
  const calls = { rpc: [], update: [], insert: [] };
  function chain(table, singularCb) {
    const obj = {
      select() { return obj; }, eq() { return obj; }, order() { return obj; },
      not() { return obj; }, ilike() { return obj; },
      maybeSingle: async () => singularCb ? singularCb() : ({ data: null, error: null }),
      single: async () => singularCb ? singularCb() : ({ data: null, error: null }),
      in: async () => ({ data: [], error: null }),
      then: (resolve) => resolve({ data: [], error: null })
    };
    void table;
    return obj;
  }
  return {
    __calls: calls,
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return { data: { ok: true }, error: null }; },
    from(table) {
      if (table === 'event_status') {
        return {
          select: () => chain(table, () => ({ data: { event_name: 'SvS', is_active: true, session_id: SESSION, start_at: '2026-08-02' }, error: null })),
          update: (payload) => { calls.update.push({ table, payload }); return chain(table); },
          insert: (payload) => { calls.insert.push({ table, payload }); return chain(table); }
        };
      }
      return {
        select: () => chain(table),
        update: (payload) => { calls.update.push({ table, payload }); return chain(table); },
        insert: (payload) => { calls.insert.push({ table, payload }); return chain(table); }
      };
    }
  };
}

function rowChecked(index) {
  return '<tr><td><input type="checkbox" class="ocr-row-cb" data-index="' + index + '" checked></td></tr>';
}

let db;
beforeEach(() => {
  resetSupabaseClient();
  document.body.innerHTML = OCR_DOM;
  localStorage.clear();
  setOcrExtractedPlayers([]);
  setOcrScanDay(1);
  db = makeDb();
  window.GM = window.GM || {};
  window.GM.db = db;
  window.GM.getActiveGuild = () => 'ALPHA';
  window.GM.getGuildTag = async () => '[FGF]';
  window.GM_EVENTS = { loadEvent: vi.fn() };
  window.currentGuild = 'ALPHA';
  window.showConfirm = vi.fn((_t, _m, cb) => { void cb(); });
});

afterEach(() => {
  vi.restoreAllMocks();
  setOcrExtractedPlayers([]);
  document.body.innerHTML = '';
  delete window.GM_EVENTS;
  delete window.currentGuild;
  delete window.showConfirm;
  localStorage.clear();
});

function seedRow() {
  document.querySelector('#ocr-results-tbody').innerHTML = rowChecked(0);
  setOcrExtractedPlayers([{ pseudo: 'Alpha', score: 12000 }]);
}

function dailyRpcCalls() {
  return db.__calls.rpc.filter((c) => c.name === 'gm_upsert_daily_scores');
}

describe('war OCR commit routing — day containers', () => {
  it('routes svs_prep to the aggregate day 0 container (SvS)', async () => {
    seedRow();
    await setOcrMetric('svs_prep');
    await commitOcrUpdates();

    const calls = dailyRpcCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual(expect.objectContaining({
      p_guild: 'ALPHA',
      p_event_name: 'SvS',
      p_session_id: SESSION,
      p_rows: [{ pseudo: 'Alpha', day: 0, score: 12000 }]
    }));
    // No direct event_participants write for war metrics.
    expect(db.__calls.update.filter((c) => c.table === 'event_participants').length).toBe(0);
  });

  it('routes gvg_prep to the aggregate day 0 container (GvG)', async () => {
    seedRow();
    await setOcrMetric('gvg_prep');
    await commitOcrUpdates();

    const calls = dailyRpcCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].args.p_event_name).toBe('GvG');
    expect(calls[0].args.p_rows).toEqual([{ pseudo: 'Alpha', day: 0, score: 12000 }]);
  });

  it('routes svs_pvp to the day 6 container', async () => {
    seedRow();
    await setOcrMetric('svs_pvp');
    await commitOcrUpdates();

    const calls = dailyRpcCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].args.p_rows).toEqual([{ pseudo: 'Alpha', day: 6, score: 12000 }]);
  });

  it('routes svs_day to the validated scanDay (default 1, or the selected day)', async () => {
    seedRow();
    await setOcrMetric('svs_day');
    expect(getCurrentOcrMetric()).toBe('svs_day');
    expect(getOcrScanDay()).toBe(1);
    await commitOcrUpdates();

    expect(dailyRpcCalls().length).toBe(1);
    expect(dailyRpcCalls()[0].args.p_rows).toEqual([{ pseudo: 'Alpha', day: 1, score: 12000 }]);

    // Select Day 3 → next commit targets day 3.
    setOcrScanDay(3);
    seedRow();
    document.querySelector('#ocr-results-tbody').innerHTML = rowChecked(0);
    await commitOcrUpdates();
    const calls = dailyRpcCalls();
    expect(calls[calls.length - 1].args.p_rows).toEqual([{ pseudo: 'Alpha', day: 3, score: 12000 }]);
  });

  it('keeps the DTR commit on the legacy event_participants path (non-regression)', async () => {
    seedRow();
    await setOcrMetric('dtr');
    await commitOcrUpdates();

    expect(dailyRpcCalls().length).toBe(0);
    expect(db.__calls.update.filter((c) => c.table === 'event_participants').length).toBe(1);
  });
});

describe('OCR modal day selector', () => {
  it('shows the day selector only for day metrics and binds the day buttons', async () => {
    await openOcrModal('svs_day');
    const selector = document.getElementById('ocr-day-selector');
    expect(selector.style.display).toBe('flex');
    expect(getOcrScanDay()).toBe(1);

    // Clicking Day 4 updates the module state used by the commit routing.
    document.querySelector('#ocr-day-buttons .gm-seg-btn[data-ocr-day="4"]').click();
    expect(getOcrScanDay()).toBe(4);
    expect(document.querySelector('#ocr-day-buttons .gm-seg-btn[data-ocr-day="4"]').classList.contains('gm-active')).toBe(true);

    // Switching to a non-day metric hides the selector.
    await setOcrMetric('svs_prep');
    expect(selector.style.display).toBe('none');
  });

  it('declares svs_day / gvg_day with dayRange [1, 5] and a prep field', () => {
    expect(OCR_METRICS_META.svs_day.isEvent).toBe(true);
    expect(OCR_METRICS_META.svs_day.eventKey).toBe('SvS');
    expect(OCR_METRICS_META.svs_day.dayRange).toEqual([1, 5]);
    expect(OCR_METRICS_META.gvg_day.eventKey).toBe('GvG');
    expect(OCR_METRICS_META.gvg_day.dayRange).toEqual([1, 5]);
  });
});

describe('Edge Function — scanDay LLM-safe validation', () => {
  const fn = read('supabase/functions/ocr-guild-members/index.ts');

  it('validates scanDay as a strict Zod integer enum 1..6 in MetadataSchema', () => {
    expect(fn).toContain('scanDay: z.number().int().min(1).max(6).optional()');
    expect(fn).toContain('MetadataSchema = z');
  });

  it('declares svs_day / gvg_day as valid metrics', () => {
    expect(fn).toContain('"svs_day"');
    expect(fn).toContain('"gvg_day"');
  });

  it('substitutes only the validated integer into the day-metric prompt', () => {
    expect(fn).toContain('svs_day: `Server vs Server (SvS) Day {day}');
    expect(fn).toContain('gvg_day: `Guild vs Guild (GvG) Day {day}');
    expect(fn).toContain('.replace("{day}", String(scanDay))');
    // The substitution is guarded to the day metrics and reads the validated
    // Zod field only — it must never come from a fresh raw string.
    expect(fn).toContain('(metricType === "svs_day" || metricType === "gvg_day") && scanDay !== undefined');
  });

  it('exposes scan_day to the model through taskMetadata', () => {
    expect(fn).toContain('scan_day: scanDay || null');
  });
});

describe('syncWarOcrGate removal', () => {
  it('removes the gate from the OCR controller and EventsView', () => {
    const controller = read('src/modules/app/ocr/ocr.controller.ts');
    const eventsView = read('src/modules/events/views/EventsView.ts');
    expect(controller).not.toContain('syncWarOcrGate');
    expect(controller).not.toContain('WarGranularGateEvent');
    expect(eventsView).not.toContain('syncWarOcrGate');
    expect(eventsView).not.toContain('warGranularFor');
    expect(eventsView).not.toContain('syncWarGates');
  });

  it('exposes a Day N OCR trigger in both event panels', () => {
    const html = read('index.html');
    expect(html).toContain('data-metric="svs_day"');
    expect(html).toContain('data-metric="gvg_day"');
    expect(html).toContain('Day N OCR');
    expect(html).toContain('Day 1 to 5 OCR (Total)');
    expect(html).toContain('Day 6 OCR');
    expect(html).toContain('id="ocr-day-buttons"');
  });
});