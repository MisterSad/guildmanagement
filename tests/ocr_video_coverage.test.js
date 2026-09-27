/**
 * Why a video scan used to miss players, and what now stops it.
 *
 * Measured on a real 88.6 s roster recording (666x590, 60 fps, 147 player rows,
 * 139 rows of net scroll). Displacement was tracked independently at 30 fps by
 * cross-correlating row profiles, median NCC 0.996, and every row of the list
 * was then checked for whether ANY frame sent to Gemini showed it whole:
 *
 *   detector output, 86 frames ......... 145/147 whole,  2 cut,  0 never seen
 *   after the shipped maxFrames = 35 ... 131/147 whole, 11 cut,  5 never seen
 *   new displacement-based selection ... 146/147 whole,  1 cut,  0 never seen
 *
 * The detection was never the defect. The caps were: ocrDownsampleEvenly threw
 * away 51 of the 86 frames the detector had correctly identified, and 16 of the
 * 147 rows became impossible for the OCR to read. A cap that decimates is not a
 * budget, it is silent data loss, and it is the whole bug report.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ocrProfileFromRoi,
  ocrEstimateProfileShift,
  ocrMeasureVerticalSharpness
} from '../src/modules/ocr/ocr.service';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Builds RGBA for a synthetic leaderboard ROI, scrolled by `offset` rows. */
function roi(width, height, offset, rowPx, blurPx) {
  const lum = (x, y) => {
    const inRow = ((y % rowPx) + rowPx) % rowPx;
    if (inRow < 2) return 60;
    const band = inRow > rowPx * 0.3 && inRow < rowPx * 0.7;
    if (!band) return 25;
    const row = Math.floor(y / rowPx);
    return (x > 4 && x < 10 + (row % 5) * 3) ? 220 : 30;
  };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0, n = 0;
      for (let k = -blurPx; k <= blurPx; k++) { v += lum(x, y + offset * rowPx + k); n++; }
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(v / n);
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('displacement is measured, not guessed', () => {
  const W = 64, H = 256, ROW = 16;

  it('recovers a sub-pitch scroll exactly', () => {
    // Within one row pitch there is no other alignment to confuse it with.
    const a = ocrProfileFromRoi(roi(W, H, 0, ROW, 0), W, H);
    for (const frac of [0.25, 0.5, 0.75]) {
      const b = ocrProfileFromRoi(roi(W, H, frac, ROW, 0), W, H);
      const { shift, score } = ocrEstimateProfileShift(a, b, Math.round(H * 0.45));
      expect(Math.abs(shift), `scroll of ${frac} row`).toBe(Math.round(frac * ROW));
      expect(score).toBeGreaterThan(0.9);
    }
  });

  it('never over-reports a scroll on a list that repeats every row', () => {
    // A roster correlates almost as well one row off as it does in place, so a
    // larger travel is reported only when the data really demands it. Under-
    // reporting costs a frame; over-reporting skips players, which is why the
    // search is biased this way and why the advance fraction absorbs the rest.
    const a = ocrProfileFromRoi(roi(W, H, 0, ROW, 0), W, H);
    for (const rows of [1, 2, 3, 5]) {
      const b = ocrProfileFromRoi(roi(W, H, rows, ROW, 0), W, H);
      const { shift } = ocrEstimateProfileShift(a, b, Math.round(H * 0.45));
      expect(Math.abs(shift), `scroll of ${rows} rows`).toBeLessThanOrEqual(rows * ROW);
      expect(Math.abs(shift) % ROW, 'lands on a row boundary').toBe(0);
    }
  });

  it('reports no movement for an identical frame', () => {
    const a = ocrProfileFromRoi(roi(W, H, 0, ROW, 0), W, H);
    const { shift } = ocrEstimateProfileShift(a, a.slice(), Math.round(H * 0.45));
    expect(shift).toBe(0);
  });

  it('degrades to a defined answer rather than throwing on bad input', () => {
    expect(ocrEstimateProfileShift(null, [1, 2])).toEqual({ shift: 0, score: 0 });
    expect(ocrEstimateProfileShift([1, 2], [1])).toEqual({ shift: 0, score: 0 });
    expect(ocrEstimateProfileShift([], [])).toEqual({ shift: 0, score: 0 });
  });
});

describe('sharpness is measured along the axis a scroll smears', () => {
  const W = 64, H = 256, ROW = 16;

  it('ranks a motion-blurred frame below a crisp one', () => {
    const crisp = ocrMeasureVerticalSharpness(roi(W, H, 0, ROW, 0), W, H);
    const blurred = ocrMeasureVerticalSharpness(roi(W, H, 0, ROW, 6), W, H);
    expect(blurred).toBeLessThan(crisp);
  });

  it('is monotonic in the amount of blur', () => {
    const scores = [0, 2, 4, 8].map((b) => ocrMeasureVerticalSharpness(roi(W, H, 0, ROW, b), W, H));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
  });
});

describe('no cap may silently decimate a scan again', () => {
  const ctrl = stripComments(read('src/modules/app/ocr/ocr.controller.ts'));

  it('keeps every frame a normal recording produces', () => {
    // 35 let a 147-row roster reach Gemini as 131 readable rows.
    const cap = /const maxFrames = o\.maxFrames \|\| (\d+);/.exec(ctrl);
    expect(cap, 'the per-video frame ceiling must stay explicit').toBeTruthy();
    expect(Number(cap[1]), 'a ceiling this low decimates a normal scan').toBeGreaterThanOrEqual(400);
  });

  it('keeps the batch ceiling far above what one recording yields', () => {
    const cap = /const MAX_OCR_IMAGES = (\d+);/.exec(ctrl);
    expect(cap).toBeTruthy();
    expect(Number(cap[1])).toBeGreaterThanOrEqual(300);
  });

  it('selects frames by displacement, leaving a guaranteed overlap', () => {
    const adv = /const OCR_VIDEO_ADVANCE_FRACTION = ([\d.]+);/.exec(ctrl);
    expect(adv, 'frame selection must be driven by measured travel').toBeTruthy();
    // Anything at or above 1.0 lets a row fall between two kept frames unread.
    expect(Number(adv[1])).toBeLessThan(0.8);
    expect(ctrl).toContain('ocrEstimateProfileShift');
  });

  it('no longer picks frames with the anti-correlated 16x16 score', () => {
    // Spearman -0.272 against a full-resolution reading of the same 587 frames:
    // it preferred the blurrier frame. The replacement scores +0.599.
    expect(ctrl).not.toContain('ocrMeasureFrameSharpness');
    expect(ctrl).toContain('ocrMeasureVerticalSharpness');
  });
});

describe('a video scan cannot hang or blow up memory', () => {
  const ctrl = stripComments(read('src/modules/app/ocr/ocr.controller.ts'));

  it('bounds every seek, because a missing seeked event never arrives', () => {
    expect(ctrl).toContain('SEEK_TIMEOUT_MS');
    expect(ctrl).toMatch(/setTimeout\(finish, SEEK_TIMEOUT_MS\)/);
  });

  it('compresses one batch at a time rather than the whole scan at once', () => {
    expect(ctrl).toContain('prepareChunk');
    // The old shape held one base64 data URL per image alive simultaneously.
    expect(ctrl).not.toMatch(/await Promise\.all\(\s*imageFiles\.map/);
  });

  it('retries only what a retry can actually fix', () => {
    expect(ctrl).toContain("RETRYABLE = ['ocr_processing_failed', 'too_many_attempts']");
    // Retrying a truncated candidate client-side just spends the tokens twice.
    expect(ctrl).not.toMatch(/RETRYABLE[^\n]*json_parse_failed/);
  });
});
