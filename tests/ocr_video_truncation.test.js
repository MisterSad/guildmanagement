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
import { geminiSupportsThinking } from '../supabase/functions/_shared/gemini.ts';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { patchAppState } from '../src/core/state/app-state';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ── The server half ─────────────────────────────────────────────────────────

describe('the Gemini call cannot spend its answer on thinking', () => {
  const fn = stripComments(read('supabase/functions/ocr-guild-members/index.ts'));

  it('asks for no thinking at all, because OCR is transcription', () => {
    expect(fn).toContain('thinking_config: { thinking_budget: 0 }');
  });

  it('leaves real headroom for the answer', () => {
    const cap = /max_output_tokens:\s*(\d+)/.exec(fn);
    expect(cap, 'max_output_tokens must still be set explicitly').toBeTruthy();
    expect(Number(cap[1])).toBeGreaterThanOrEqual(32768);
    expect(fn, 'the old shared-with-thinking budget must not come back').not.toContain('max_output_tokens: 8192');
  });

  it('only sends thinking_config to models that accept it', () => {
    // Gemini 2.0 answers 400 INVALID_ARGUMENT rather than ignoring it, and it
    // is in the fallback list.
    expect(geminiSupportsThinking('gemini-flash-latest')).toBe(true);
    expect(geminiSupportsThinking('gemini-2.5-flash')).toBe(true);
    expect(geminiSupportsThinking('gemini-2.0-flash')).toBe(false);
    expect(fn).toContain('geminiSupportsThinking(modelName)');
  });

  it('retries without thinking_config rather than failing on a 400', () => {
    // An optimisation must never be able to take the whole feature down.
    expect(fn).toContain('resp.status === 400 && geminiSupportsThinking(modelName)');
    const retry = fn.slice(fn.indexOf('resp.status === 400'), fn.indexOf('if (!resp.ok)'));
    expect(retry).toContain('generationConfig: baseGenerationConfig');
    expect(retry).not.toContain('thinking_budget');
  });
});

describe('a truncated answer is refused, not parsed', () => {
  const fn = stripComments(read('supabase/functions/ocr-guild-members/index.ts'));

  it('checks finishReason before accepting the text', () => {
    const check = fn.indexOf('finishReason !== "STOP"');
    const accept = fn.indexOf('geminiResultRaw = textCandidate');
    expect(check).toBeGreaterThan(-1);
    expect(accept).toBeGreaterThan(-1);
    expect(check, 'the guard must come before the assignment it guards').toBeLessThan(accept);
  });

  it('falls through to the next model instead of breaking out', () => {
    // `break` on a truncated candidate is what removed every chance of
    // recovery: the loop ended, then JSON.parse threw, then the user got a 500.
    const guard = fn.slice(fn.indexOf('finishReason !== "STOP"'), fn.indexOf('if (textCandidate) {'));
    expect(guard).toContain('continue;');
    expect(guard).not.toContain('break;');
  });

  it('records the token usage, so the next investigation has the numbers', () => {
    expect(fn).toContain('usage: respData?.usageMetadata ?? null');
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
