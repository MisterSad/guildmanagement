/**
 * supabase/functions/ocr-guild-members/video.ts
 *
 * The video path of the OCR (ADR-021). The browser used to cut a recording into
 * frames itself and send them in batches of four; how many players it found
 * depended entirely on a scroll estimator tuned on one desktop recording, and on
 * other recordings it found 3 or 4 players out of 40. The video is now handed
 * to the model whole (through OpenRouter since ADR-024), and what this module adds is the part a model cannot be
 * trusted with on its own: knowing whether it read everything.
 *
 * Leaderboards print a position on every row. A gap in the positions the model
 * returns is a player it skipped, so the gap is measured here and a second,
 * targeted pass asks for exactly those rows. A roster without positions falls
 * back to the member counter the game shows ("40/40") when it is visible.
 *
 * No URL imports, on purpose: everything here is pure, so vitest imports this
 * file directly.
 */

export const OCR_VIDEO_BUCKET = "ocr-videos";
/**
 * Same ceiling as the bucket's file_size_limit (migration ocr_videos_20mb).
 * Was 64 MiB with the Gemini File API; OpenRouter takes a recording inline as
 * base64 (ADR-024), so the request is a third larger than the file.
 */
export const OCR_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
export const OCR_VIDEO_MAX_DURATION_SEC = 300;
export const OCR_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

/** `<guild>/<uuid>.<ext>` -- the only object names the client is allowed to send. */
export const OCR_VIDEO_PATH_REGEX =
  /^[A-Za-z0-9_-]{1,64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm)$/;

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

/** At most this many positions are reported or sent back to the model. */
export const OCR_VIDEO_MAX_MISSING = 200;

function validPosition(p: unknown): number | null {
  const n = typeof p === "number" ? p : typeof p === "string" ? parseInt(p, 10) : NaN;
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
  return { expected: expectedFromScreen ?? hi - lo + 1, found, missingPositions: missing };
}

export function ocrNeedsSecondPass(c: VideoCoverage): boolean {
  return c.missingPositions.length > 0 || (c.expected !== null && c.found < c.expected);
}

function pseudoKey(p: VideoPlayer): string {
  return String(p.pseudo || "")
    .toLowerCase()
    .replace(/\s+/g, "");
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
