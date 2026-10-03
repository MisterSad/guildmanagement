/**
 * supabase/functions/ocr-guild-members/video.ts
 *
 * The video path of the OCR (ADR-021). The browser used to cut a recording into
 * frames itself and send them in batches of four; how many players it found
 * depended entirely on a scroll estimator tuned on one desktop recording, and on
 * other recordings it found 3 or 4 players out of 40. The video is now handed
 * to Gemini whole, and what this module adds is the part a model cannot be
 * trusted with on its own: knowing whether it read everything.
 *
 * Leaderboards print a position on every row. A gap in the positions Gemini
 * returns is a player it skipped, so the gap is measured here and a second,
 * targeted pass asks for exactly those rows. A roster without positions falls
 * back to the member counter the game shows ("40/40") when it is visible.
 *
 * No URL imports, on purpose: everything here is pure or takes its `fetch` as a
 * parameter, so vitest imports this file directly.
 */

export const OCR_VIDEO_BUCKET = "ocr-videos";
/** Same ceiling as the bucket's file_size_limit (migration 20261001194004). */
export const OCR_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const OCR_VIDEO_MAX_DURATION_SEC = 300;
export const OCR_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

/** `<guild>/<uuid>.<ext>` -- the only object names the client is allowed to send. */
export const OCR_VIDEO_PATH_REGEX =
  /^[A-Za-z0-9_-]{1,64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm)$/;

/**
 * Frames Gemini samples per second. Its default is 1, and a list scrolled at a
 * normal thumb speed moves several rows a second, so 1 fps skips players. The
 * rate is set from the duration so that the frame count stays inside a budget:
 * at high media resolution a frame costs 258 tokens, so 600 frames is ~155k
 * tokens. The second pass looks twice as closely, because it only runs when the
 * first one demonstrably missed rows.
 */
export const OCR_VIDEO_FRAME_BUDGET = 600;
export const OCR_VIDEO_MAX_FPS = 8;
export const OCR_VIDEO_SECOND_PASS_MAX_FPS = 10;

export function ocrVideoFps(durationSec: number, pass: 1 | 2 = 1): number {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : OCR_VIDEO_MAX_DURATION_SEC;
  const budget = pass === 2 ? OCR_VIDEO_FRAME_BUDGET * 2 : OCR_VIDEO_FRAME_BUDGET;
  const ceiling = pass === 2 ? OCR_VIDEO_SECOND_PASS_MAX_FPS : OCR_VIDEO_MAX_FPS;
  const fps = Math.floor(budget / d);
  return Math.max(1, Math.min(ceiling, fps));
}

/** Gemini reports durations as protobuf Duration strings: "25.561s". */
export function parseGeminiDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

export interface VideoPlayer {
  pseudo: string;
  position?: number | null;
  [key: string]: unknown;
}

export interface VideoCoverage {
  /** Rows the list is known to contain, or null when nothing on screen says. */
  expected: number | null;
  found: number;
  /** Positions inside the observed range that no returned row carries. */
  missingPositions: number[];
}

/** At most this many positions are reported or sent back to Gemini. */
export const OCR_VIDEO_MAX_MISSING = 200;

function validPosition(p: unknown): number | null {
  const n = typeof p === "number" ? p : (typeof p === "string" ? parseInt(p, 10) : NaN);
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : null;
}

/**
 * Measures what the reading covered.
 *
 * `filtered` is true when the model was told to keep only one guild's rows out
 * of a multi-guild ranking: the other guilds' positions are then absent by
 * design, and a gap proves nothing.
 *
 * The range starts at the lowest position read, not at 1, because a recording
 * may begin mid-list. It extends to the on-screen counter only when the list
 * was read from its top.
 */
export function ocrVideoCoverage(
  players: VideoPlayer[],
  expectedCount: number | null,
  filtered: boolean
): VideoCoverage {
  const found = players.length;
  const expectedFromScreen = validPosition(expectedCount);
  if (filtered) return { expected: null, found, missingPositions: [] };

  const positions = new Set<number>();
  for (const p of players) {
    const pos = validPosition(p.position);
    if (pos !== null) positions.add(pos);
  }
  if (positions.size === 0) {
    return { expected: expectedFromScreen, found, missingPositions: [] };
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const pos of positions) {
    if (pos < lo) lo = pos;
    if (pos > hi) hi = pos;
  }
  if (expectedFromScreen !== null && lo === 1) hi = Math.max(hi, expectedFromScreen);

  const missing: number[] = [];
  for (let pos = lo; pos <= hi && missing.length < OCR_VIDEO_MAX_MISSING; pos++) {
    if (!positions.has(pos)) missing.push(pos);
  }
  return { expected: expectedFromScreen ?? (hi - lo + 1), found, missingPositions: missing };
}

export function ocrNeedsSecondPass(c: VideoCoverage): boolean {
  return c.missingPositions.length > 0 || (c.expected !== null && c.found < c.expected);
}

function pseudoKey(p: VideoPlayer): string {
  return String(p.pseudo || "").toLowerCase().replace(/\s+/g, "");
}

/**
 * Adds the second pass's rows to the first's. A row is new when neither its
 * position nor its name is already held: the second pass is told what was
 * found, but it is still a model, and it will sometimes hand a row back.
 * On a clash the first reading wins -- it was made under the same conditions,
 * and keeping it means a second pass can only ever add players.
 */
export function mergeVideoPasses(first: VideoPlayer[], second: VideoPlayer[]): VideoPlayer[] {
  const out = first.slice();
  const positions = new Set<number>();
  const names = new Set<string>();
  for (const p of first) {
    const pos = validPosition(p.position);
    if (pos !== null) positions.add(pos);
    names.add(pseudoKey(p));
  }
  for (const p of second) {
    const pos = validPosition(p.position);
    const key = pseudoKey(p);
    if (!key) continue;
    if (pos !== null && positions.has(pos)) continue;
    if (names.has(key)) continue;
    out.push(p);
    if (pos !== null) positions.add(pos);
    names.add(key);
  }
  return out;
}

// ── Gemini File API ──────────────────────────────────────────────────────────
// Authenticated with the x-goog-api-key header, never a query parameter, so no
// URL built or returned here carries the key. Errors name the step and the
// status only -- never a URL, never a response header.

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const FILE_NAME_REGEX = /^files\/[a-z0-9-]{1,64}$/;

export interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  durationSec: number | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function toGeminiFile(f: any): GeminiFile | null {
  if (!f || typeof f.name !== "string" || !FILE_NAME_REGEX.test(f.name) || typeof f.uri !== "string") return null;
  return {
    name: f.name,
    uri: f.uri,
    mimeType: String(f.mimeType || ""),
    durationSec: parseGeminiDuration(f.videoMetadata?.videoDuration),
  };
}

/** Resumable upload in one request: `start`, then `upload, finalize`. */
export async function geminiUploadFile(
  apiKey: string,
  bytes: ArrayBuffer,
  mimeType: string,
  fetchImpl: FetchLike = fetch
): Promise<GeminiFile> {
  const start = await fetchImpl(`${GEMINI_BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "ocr-video" } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) {
    await start.body?.cancel();
    throw new Error(`gemini_upload_start_${start.status}`);
  }
  await start.body?.cancel();

  const done = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!done.ok) {
    await done.body?.cancel();
    throw new Error(`gemini_upload_${done.status}`);
  }
  const file = toGeminiFile((await done.json())?.file);
  if (!file) throw new Error("gemini_upload_bad_response");
  return file;
}

/**
 * A video is unusable until Gemini has finished processing it. Polls with a
 * growing interval until ACTIVE; FAILED or the deadline is an error.
 */
export async function geminiWaitActive(
  apiKey: string,
  name: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<GeminiFile> {
  if (!FILE_NAME_REGEX.test(name)) throw new Error("gemini_file_bad_name");
  const deadline = Date.now() + timeoutMs;
  let wait = 1000;
  while (true) {
    const resp = await fetchImpl(`${GEMINI_BASE}/v1beta/${name}`, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new Error(`gemini_file_get_${resp.status}`);
    }
    const raw = await resp.json();
    const state = raw?.state;
    if (state === "ACTIVE") {
      const file = toGeminiFile(raw);
      if (!file) throw new Error("gemini_file_bad_response");
      return file;
    }
    if (state === "FAILED") throw new Error("gemini_file_failed");
    if (Date.now() + wait > deadline) throw new Error("gemini_file_timeout");
    await sleep(wait);
    wait = Math.min(wait * 2, 5000);
  }
}

/** Best effort: Gemini deletes uploads by itself after 48 h if this fails. */
export async function geminiDeleteFile(apiKey: string, name: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  if (!FILE_NAME_REGEX.test(name)) return false;
  try {
    const resp = await fetchImpl(`${GEMINI_BASE}/v1beta/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": apiKey },
    });
    await resp.body?.cancel();
    return resp.ok;
  } catch {
    return false;
  }
}
