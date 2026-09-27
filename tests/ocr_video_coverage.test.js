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

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ocrProfileFromRoi,
  ocrEstimateProfileShift,
  ocrMeasureVerticalSharpness,
  fuseOcrPlayers,
  compressImageForUpload
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

describe('fusion may not make a player disappear', () => {
  // findBestMatchingMember answers from a similarity of 0.75, and fuseOcrPlayers
  // rewrote anything from 0.80 to the member's own spelling. Two different
  // players with close names both became that member, collapsed onto one key,
  // and the results table silently showed one of them.
  //
  // Measured on real roster names, string distance cannot tell the two cases
  // apart: Coreman/C0reman is 0.857 and is one player misread, Sonz/Sonz2 is
  // 0.800 and is two players. The score decides instead.
  const roster = [{ pseudo: 'Sonz', uid: '100001' }, { pseudo: 'Coreman', uid: '100002' }];

  it('keeps two players whose names are close but whose scores are not', () => {
    const fused = fuseOcrPlayers(
      [{ pseudo: 'Sonz', score: 103827335 }, { pseudo: 'Sonz2', score: 51671987 }],
      roster,
      null
    );
    expect(fused).toHaveLength(2);
    expect(fused.map((f) => f.pseudo).sort()).toEqual(['Sonz', 'Sonz2']);
    expect(fused.find((f) => f.pseudo === 'Sonz').score).toBe(103827335);
    expect(fused.find((f) => f.pseudo === 'Sonz2').score).toBe(51671987);
  });

  it('still corrects a misread name onto its member when the score agrees', () => {
    // The same row, read off two frames, one of them with a 0 for an O.
    const fused = fuseOcrPlayers(
      [{ pseudo: 'Coreman', score: 94740921 }, { pseudo: 'C0reman', score: 94740921 }],
      roster,
      null
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].pseudo).toBe('Coreman');
  });

  it('still merges one player read off several frames', () => {
    const fused = fuseOcrPlayers(
      [
        { pseudo: 'Sonz', score: 103827335 },
        { pseudo: 'Sonz', score: 103827335 },
        { pseudo: 'sonz', score: 103827335, uid: '100001' }
      ],
      roster,
      null
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].pseudo).toBe('Sonz');
    expect(fused[0].uid).toBe('100001');
  });

  it('corrects a typo onto an unclaimed member, as before', () => {
    const fused = fuseOcrPlayers([{ pseudo: 'C0reman', score: 500 }], roster, null);
    expect(fused).toHaveLength(1);
    expect(fused[0].pseudo).toBe('Coreman');
  });
});

describe('the repeated prompt, not the images, is the token cost', () => {
  const ctrl = stripComments(read('src/modules/app/ocr/ocr.controller.ts'));

  it('sends enough images per call to amortise the system instruction', () => {
    // Measured on a 64-frame scan: 34,272 tokens of re-sent prompt against
    // 16,512 of image. Two images per call spends more on the question than
    // on what is being asked about.
    const cs = /const chunkSize = (\d+);/.exec(ctrl);
    expect(cs).toBeTruthy();
    expect(Number(cs[1])).toBeGreaterThanOrEqual(3);
    // The Edge Function rejects more than five, in Zod and in an early guard.
    expect(Number(cs[1])).toBeLessThanOrEqual(5);
  });
});

describe('an already-compressed frame is not compressed again', () => {
  // The extractor writes frames as JPEG at q0.85, well under the 1600 px bound,
  // and they were being decoded and re-encoded at q0.82 on the way out. Small
  // text is the first thing a second JPEG generation damages, and small text is
  // the whole job.
  const ORIGINAL = 'data:image/jpeg;base64,ORIGINALBYTES';
  const RECODED = 'data:image/jpeg;base64,RECODEDBYTES';

  const stubEnv = (w, h) => {
    vi.stubGlobal('FileReader', class {
      readAsDataURL() { queueMicrotask(() => this.onload({ target: { result: ORIGINAL } })); }
    });
    vi.stubGlobal('Image', class {
      constructor() { this.width = w; this.height = h; }
      set src(_v) { queueMicrotask(() => this.onload && this.onload()); }
    });
    const toDataURL = vi.fn(() => RECODED);
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0, toDataURL,
        getContext: () => ({ drawImage() {} })
      })
    });
    return toDataURL;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('passes an in-bounds JPEG through byte for byte', async () => {
    const toDataURL = stubEnv(666, 590);
    const out = await compressImageForUpload(new Blob(['x'], { type: 'image/jpeg' }), 1600, 0.82);
    expect(out).toBe(ORIGINAL);
    expect(toDataURL, 'the canvas must not be touched at all').not.toHaveBeenCalled();
  });

  it('still shrinks a JPEG that is over the bound', async () => {
    const toDataURL = stubEnv(3000, 2000);
    const out = await compressImageForUpload(new Blob(['x'], { type: 'image/jpeg' }), 1600, 0.82);
    expect(out).toBe(RECODED);
    expect(toDataURL).toHaveBeenCalled();
  });

  it('still converts an in-bounds PNG, which is what the size saving is for', async () => {
    const toDataURL = stubEnv(666, 590);
    const out = await compressImageForUpload(new Blob(['x'], { type: 'image/png' }), 1600, 0.82);
    expect(out).toBe(RECODED);
    expect(toDataURL).toHaveBeenCalled();
  });
});
