/**
 * Why a Glory scan failed on a video and succeeded on screenshots.
 *
 * Measured in production over 24h on 2026-09-27: 147 OCR extractions completed,
 * average 11.7s; 3 failed, and all three took 30.4s, 32.7s and 34.0s. Each
 * failure was a WELL-FORMED Gemini envelope whose JSON text stopped mid-object
 * at ~1,900 characters -- around 600 tokens, nowhere near the 8,192-token cap
 * that was configured. The thinking tokens are spent out of that same budget,
 * so the model thought its answer away and the function parsed the fragment.
 *
 * Two independent defects, one visible symptom:
 *   1. a truncated candidate was logged as a success and then thrown at
 *      JSON.parse, with no retry, because the model loop had already broken;
 *   2. on the client, ONE failed batch rejected Promise.all and discarded every
 *      batch that had succeeded. A screenshot is one batch (2% failure), a
 *      video is ~18 batches (about 30% that at least one fails). That ratio is
 *      the whole bug report.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { handleOcrFiles } from '../src/modules/app/ocr/ocr.controller';
import { setCurrentOcrMetric, setOcrExtractedPlayers, getOcrExtractedPlayers } from '../src/modules/app/ocr/ocr.meta';
import { setGuildMembers, clearMembersStore } from '../src/modules/app/members/members.store';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { patchAppState } from '../src/core/state/app-state';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ── The server half ─────────────────────────────────────────────────────────

// Since ADR-024 the model is called through _shared/openrouter.ts, whose
// behaviour is run by supabase/functions/_shared/openrouter.test.ts: a `length`
// finish is refused and the next model tried, never parsed. What stays here is
// the OCR function's own budget. Reasoning cannot be turned off on
// google/gemini-3.8-flash (it is mandatory there), so the budget it shares with
// the answer must stay generous.
describe('the OCR answer keeps its headroom', () => {
  const fn = stripComments(read('supabase/functions/ocr-guild-members/index.ts'));
  const client = stripComments(read('supabase/functions/_shared/openrouter.ts'));

  it('leaves real headroom for the answer', () => {
    const cap = /maxTokens:\s*(\d+)/.exec(fn);
    expect(cap, 'maxTokens must be set explicitly').toBeTruthy();
    expect(Number(cap[1])).toBeGreaterThanOrEqual(32768);
  });

  it('asks for the lowest reasoning the model accepts', () => {
    expect(client).toContain('reasoning: { effort: "low", exclude: true }');
  });

  it('refuses anything but a clean stop', () => {
    expect(client).toContain('if (finish !== "stop")');
  });
});

// ── The client half ─────────────────────────────────────────────────────────

const OCR_DOM = `
  <div id="ocr-modal-overlay">
    <div id="ocr-tag-input-group"><input id="ocr-guild-tag-input" value="FGF" /></div>
    <div id="ocr-dropzone"></div>
    <div id="ocr-loading" style="display:none"><h4></h4><p></p></div>
    <div id="ocr-results-container" style="display:none">
      <table><thead><tr><th id="ocr-metric-header"></th><th id="ocr-rank-header"></th></tr></thead>
      <tbody id="ocr-results-tbody"></tbody></table>
      <table><tbody id="ocr-results-tbody-new"></tbody></table>
      <table><tbody id="ocr-results-tbody-removed"></tbody></table>
    </div>
    <span id="ocr-detected-count">0</span>
    <div id="ocr-summary-badges"></div>
    <button id="ocr-commit-btn"><span></span></button>
  </div>
  <div id="toast-container"></div>
`;

const MEMBERS = [
  { pseudo: 'Alpha', uid: '111111', role: 'R1', guild: 'ALPHA', glory_score: 1 },
  { pseudo: 'Bravo', uid: '222222', role: 'R1', guild: 'ALPHA', glory_score: 1 },
  { pseudo: 'Delta', uid: '444444', role: 'R1', guild: 'ALPHA', glory_score: 1 },
];

/**
 * Enough frames for three batches, whatever the controller's chunk size is.
 * Pinning six frames here pinned "three batches of two" with them, so raising
 * the chunk size to amortise the re-sent system prompt broke a test that is
 * about surviving a failed batch and has no opinion on how big a batch is.
 */
const CHUNK_SIZE = Number(
  /const chunkSize = (\d+);/.exec(
    fs.readFileSync(path.join(rootDir, 'src/modules/app/ocr/ocr.controller.ts'), 'utf8')
  )[1]
);
const BATCHES = 3;
const frames = () => new Array(CHUNK_SIZE * BATCHES).fill(0).map(() => new Blob(['frame'], { type: 'image/png' }));

const toastText = () => document.getElementById('toast-container').textContent;

function stubInvoke(perBatch) {
  let batch = 0;
  return vi.fn(async () => {
    const outcome = perBatch[batch++];
    return { data: outcome, error: null };
  });
}

beforeEach(() => {
  document.body.innerHTML = OCR_DOM;
  clearMembersStore();
  setGuildMembers(MEMBERS.map((m) => ({ ...m })));
  setOcrExtractedPlayers([]);
  setCurrentOcrMetric('glory');

  // jsdom decodes no images, so the compressor's <img> would never settle.
  // Failing it takes the base64 fallback, which is a real path in production.
  vi.stubGlobal(
    'Image',
    class {
      set src(_v) {
        queueMicrotask(() => {
          if (this.onerror) this.onerror();
        });
      }
    }
  );

  // The controller resolves the guild and its tag through the real modules.
  patchAppState({ currentGuild: 'ALPHA' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetSupabaseClient();
  clearMembersStore();
  setOcrExtractedPlayers([]);
  document.body.innerHTML = '';
});

describe('one bad batch does not discard the good ones', () => {
  it('keeps the players the surviving batches read', async () => {
    setDbClient({
      functions: {
        invoke: stubInvoke([
          { ok: true, players: [{ pseudo: 'Alpha', score: 500, raw_score: '500' }] },
          { ok: false, error: 'json_parse_failed' },
          { ok: true, players: [{ pseudo: 'Bravo', score: 400, raw_score: '400' }] },
        ]),
      },
    });

    await handleOcrFiles(frames());

    const found = getOcrExtractedPlayers()
      .map((p) => p.pseudo)
      .sort();
    expect(found, 'batches 1 and 3 must survive batch 2').toEqual(['Alpha', 'Bravo']);
    expect(document.getElementById('ocr-results-container').style.display).not.toBe('none');
  });

  it('says so, because a silent partial scan is worse than a loud one', async () => {
    setDbClient({
      functions: {
        invoke: stubInvoke([
          { ok: true, players: [{ pseudo: 'Alpha', score: 500, raw_score: '500' }] },
          { ok: false, error: 'json_parse_failed' },
          { ok: true, players: [{ pseudo: 'Bravo', score: 400, raw_score: '400' }] },
        ]),
      },
    });

    await handleOcrFiles(frames());

    expect(toastText()).toContain('1 of ' + BATCHES + ' batches failed');
    expect(toastText()).toContain('incomplete');
  });

  it('still fails outright when nothing at all came back', async () => {
    setDbClient({
      functions: {
        invoke: stubInvoke([
          { ok: false, error: 'json_parse_failed' },
          { ok: false, error: 'json_parse_failed' },
          { ok: false, error: 'json_parse_failed' },
        ]),
      },
    });

    await handleOcrFiles(frames());

    expect(getOcrExtractedPlayers()).toEqual([]);
    expect(document.getElementById('ocr-dropzone').style.display).toBe('block');
    // And in words, not in the server's error code.
    expect(toastText()).not.toContain('json_parse_failed');
    expect(toastText()).toContain('incomplete reading');
  });
});
