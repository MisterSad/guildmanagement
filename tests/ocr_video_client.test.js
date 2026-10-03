/**
 * The browser half of the video OCR (ADR-021): the recording is staged in the
 * private `ocr-videos` bucket under the active guild, the Edge Function reads
 * it whole, and the table says what the reading covered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { handleOcrFiles, callGeminiOcrVideoApi, resetOcrModalState } from '../src/modules/app/ocr/ocr.controller';
import { setCurrentOcrMetric, setOcrExtractedPlayers, getOcrExtractedPlayers, getOcrVideoCoverage } from '../src/modules/app/ocr/ocr.meta';
import { renderOcrCoverage } from '../src/modules/app/ocr/ocr.render';
import { setGuildMembers, clearMembersStore } from '../src/modules/app/members/members.store';
import { patchAppState, resetAppState } from '../src/core/state/app-state';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');

const OCR_DOM = `
  <div id="ocr-modal-overlay">
    <div id="ocr-tag-input-group"><input id="ocr-guild-tag-input" value="PR1M" /></div>
    <div id="ocr-dropzone"></div>
    <div id="ocr-loading" style="display:none"><h4></h4><p></p></div>
    <div id="ocr-results-container" style="display:none">
      <div id="ocr-coverage-banner" style="display:none"></div>
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

const UUID_PATH = /^ALPHA\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;
const video = (type = 'video/mp4', bytes = 16) => new File([new Uint8Array(bytes)], 'scan.mp4', { type });
const toastText = () => document.getElementById('toast-container').textContent;
const banner = () => document.getElementById('ocr-coverage-banner');

function stubDb({ uploadError = null, response }) {
  const upload = vi.fn(async () => ({ data: { path: 'x' }, error: uploadError }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const invoke = vi.fn(async () => ({ data: response, error: null }));
  window.GM.db = {
    storage: { from: vi.fn(() => ({ upload, remove })) },
    functions: { invoke },
  };
  return { upload, remove, invoke, from: window.GM.db.storage.from };
}

// jsdom loads no media, so a <video> never fires loadedmetadata or error and the
// duration probe would wait for its timeout. Each test says what the "browser"
// makes of the file: undecodable (error) by default, or a given duration.
const mediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
const mediaDuration = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
function browserReadsDuration(seconds) {
  Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => seconds });
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    set(_v) { queueMicrotask(() => this.dispatchEvent(new Event(seconds === null ? 'error' : 'loadedmetadata'))); },
    get() { return ''; },
  });
}

beforeEach(() => {
  browserReadsDuration(null);
  document.body.innerHTML = OCR_DOM;
  clearMembersStore();
  setGuildMembers([{ pseudo: 'ODIN', uid: '1', role: 'R1', guild: 'ALPHA', glory_score: 1 }]);
  setOcrExtractedPlayers([]);
  setCurrentOcrMetric('glory');
  resetAppState();
  patchAppState({ currentGuild: 'ALPHA' });
  window.GM = window.GM || {};
  window.GM.getActiveGuild = () => 'ALPHA';
  window.GM.getGuildTag = async () => 'PR1M';
});

afterEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'src', mediaSrc);
  Object.defineProperty(HTMLMediaElement.prototype, 'duration', mediaDuration);
  vi.restoreAllMocks();
  clearMembersStore();
  setOcrExtractedPlayers([]);
  resetAppState();
  document.body.innerHTML = '';
  delete window.GM.db;
});

describe('a video is staged, then read whole by the server', () => {
  it('uploads under <guild>/<uuid>.<ext> and sends only that path', async () => {
    const db = stubDb({ response: { ok: true, players: [{ pseudo: 'ODIN', score: 59080000, raw_score: '59,08M', position: 2 }], coverage: { expected: 1, found: 1, missingPositions: [] } } });

    const out = await callGeminiOcrVideoApi(video(), 'glory', 'PR1M', null);

    expect(db.from).toHaveBeenCalledWith('ocr-videos');
    const [uploadPath, , uploadOpts] = db.upload.mock.calls[0];
    expect(uploadPath).toMatch(UUID_PATH);
    expect(uploadOpts).toEqual({ contentType: 'video/mp4', upsert: false });

    const [fnName, { body }] = db.invoke.mock.calls[0];
    expect(fnName).toBe('ocr-guild-members');
    expect(body.video).toEqual({ path: uploadPath, mimeType: 'video/mp4' });
    expect(body).not.toHaveProperty('images');
    expect(out.players[0].score).toBe(59080000);
    expect(out.coverage).toEqual({ expected: 1, found: 1, missingPositions: [] });
  });

  it('removes the staged object even when the call fails', async () => {
    const db = stubDb({ response: { ok: false, error: 'ocr_processing_failed' } });
    await expect(callGeminiOcrVideoApi(video(), 'glory', 'PR1M', null)).rejects.toThrow('ocr_processing_failed');
    expect(db.remove).toHaveBeenCalledWith([db.upload.mock.calls[0][0]]);
  });

  it('maps a QuickTime recording to .mov', async () => {
    const db = stubDb({ response: { ok: true, players: [] } });
    await callGeminiOcrVideoApi(video('video/quicktime'), 'glory', 'PR1M', null);
    expect(db.upload.mock.calls[0][0]).toMatch(/\.mov$/);
  });
});

describe('refused before anything is uploaded', () => {
  it('an unsupported format', async () => {
    const db = stubDb({ response: { ok: true, players: [] } });
    await expect(callGeminiOcrVideoApi(video('video/x-matroska'), 'glory', '', null)).rejects.toThrow('video_unsupported_type');
    expect(db.upload).not.toHaveBeenCalled();
  });

  it('a file over the bucket limit', async () => {
    const db = stubDb({ response: { ok: true, players: [] } });
    await expect(callGeminiOcrVideoApi(video('video/mp4', 64 * 1024 * 1024 + 1), 'glory', '', null)).rejects.toThrow('video_too_large');
    expect(db.upload).not.toHaveBeenCalled();
  });

  it('a recording the browser measures at over five minutes', async () => {
    browserReadsDuration(301);
    const db = stubDb({ response: { ok: true, players: [] } });
    await expect(callGeminiOcrVideoApi(video(), 'glory', '', null)).rejects.toThrow('video_too_long');
    expect(db.upload).not.toHaveBeenCalled();
  });

  it('but not one the browser cannot decode: Gemini may still read it', async () => {
    browserReadsDuration(null);
    const db = stubDb({ response: { ok: true, players: [] } });
    await callGeminiOcrVideoApi(video(), 'glory', '', null);
    expect(db.upload).toHaveBeenCalled();
  });

  it('no active guild: it fails visibly, it never guesses one', async () => {
    resetAppState();
    patchAppState({ currentGuild: null, currentGuildRestriction: null });
    try { localStorage.removeItem('gm_current_guild'); } catch { /* jsdom */ }
    const db = stubDb({ response: { ok: true, players: [] } });
    await expect(callGeminiOcrVideoApi(video(), 'glory', '', null)).rejects.toThrow('no_active_guild');
    expect(db.upload).not.toHaveBeenCalled();
  });

  it('an upload the bucket rejected', async () => {
    stubDb({ uploadError: { message: 'new row violates row-level security policy' }, response: { ok: true, players: [] } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(callGeminiOcrVideoApi(video(), 'glory', '', null)).rejects.toThrow('video_upload_failed');
  });
});

describe('the scan flow', () => {
  it('shows the players and an incomplete-coverage warning naming the missing positions', async () => {
    stubDb({
      response: {
        ok: true,
        players: [
          { pseudo: 'ODIN', score: 59080000, raw_score: '59,08M', position: 2 },
          { pseudo: 'Cookiegami', score: 55210000, raw_score: '55,21M', position: 3 },
        ],
        coverage: { expected: 41, found: 2, missingPositions: [1, 4, 5] },
        passes: 2,
      },
    });

    await handleOcrFiles([video()]);

    expect(getOcrExtractedPlayers().map((p) => p.pseudo).sort()).toEqual(['Cookiegami', 'ODIN']);
    expect(getOcrVideoCoverage()).toEqual({ expected: 41, found: 2, missingPositions: [1, 4, 5] });
    expect(banner().style.display).toBe('block');
    expect(banner().textContent).toContain('2 / 41');
    expect(banner().textContent).toContain('Missing rank positions: 1, 4, 5');
  });

  it('a video that fails alone says why, and goes back to the dropzone', async () => {
    stubDb({ response: { ok: false, error: 'video_processing_failed' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleOcrFiles([video()]);
    expect(toastText()).toContain('could not process that video');
    expect(document.getElementById('ocr-dropzone').style.display).toBe('block');
  });

  it('reset hides the banner', () => {
    renderOcrCoverage({ expected: 3, found: 3, missingPositions: [] });
    expect(banner().style.display).toBe('block');
    resetOcrModalState();
    expect(banner().style.display).toBe('none');
    expect(getOcrVideoCoverage()).toBeNull();
  });
});

describe('the coverage banner', () => {
  it('confirms a complete reading', () => {
    renderOcrCoverage({ expected: 41, found: 41, missingPositions: [] });
    expect(banner().textContent).toContain('read in full: 41 / 41');
  });

  it('says plainly when nothing on screen gave a total', () => {
    renderOcrCoverage({ expected: null, found: 12, missingPositions: [] });
    expect(banner().textContent).toContain('Nothing on screen gave a total');
  });

  it('truncates a long list of missing positions', () => {
    renderOcrCoverage({ expected: 100, found: 50, missingPositions: Array.from({ length: 30 }, (_, i) => i + 51) });
    expect(banner().textContent).toContain('(+10 more)');
  });
});

describe('the frame extractor is gone', () => {
  const ctrl = read('src/modules/app/ocr/ocr.controller.ts');
  const svc = read('src/modules/ocr/ocr.service.ts');
  it('leaves no frame selection in the browser', () => {
    for (const gone of ['extractFramesFromVideo', 'ocrSampleRoi', 'ocrEstimateProfileShift', 'ocrProfileFromRoi', 'OCR_VIDEO_ADVANCE_FRACTION']) {
      expect(ctrl, gone).not.toContain(gone);
      expect(svc, gone).not.toContain(gone);
    }
  });
  it('declares the coverage banner in the modal', () => {
    expect(read('index.html')).toContain('id="ocr-coverage-banner"');
  });
});
