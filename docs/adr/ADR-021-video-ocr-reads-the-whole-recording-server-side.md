# ADR-021: Video OCR reads the whole recording, server-side, and measures its own coverage

- **Status**: Accepted
- **Date**: 2026-10-01 (phase 1); phase 2 on 2026-10-03
- **Supersedes**: the in-browser frame extractor (`extractFramesFromVideo`)
- **Related**: ADR-003 (tenant isolation), ADR-012 (OCR cache, image path), ADR-017 (versioned Edge Functions), ADR-018 (GDPR data inventory)

## Context

Officers import a roster or a leaderboard by scanning the game's screen,
either with screenshots or with a screen recording scrolled through the list.

The recording used to be cut into still frames **in the browser**: a sharpness
score and a scroll-displacement estimator chose which frames to keep, and the
frames went to `ocr-guild-members` four at a time. Which frames were kept
decided which players were found. The estimator had been tuned on one desktop
capture; on other recordings it found **3 or 4 players out of 40**. A first
repair (2026-09-27) showed that the caps on frame selection, not the detection,
were losing rows — but any client-side selection stays a guess about what the
model will need.

Sending the video in the request body is not an option either. Measured on
production: a 1 MB binary body hung `ocr-guild-members` for 160 s, and 60 MB
bodies ended in a gateway 502.

## Decision

**The browser no longer selects frames. The whole recording is handed to
Gemini on the server, and the server checks whether it read everything.**

1. **Staging, not the request body.** The browser checks the file (MP4, MOV or
   WebM; at most 64 MB; at most 5 minutes when it can read the duration — a
   file it cannot decode, such as HEVC on some desktops, is still sent) and
   uploads it to the private `ocr-videos` bucket as `<guild>/<uuid>.<ext>`
   (migration `20261001194004_ocr_videos_bucket`). `ocr-guild-members` then
   receives only that path, validated against `OCR_VIDEO_PATH_REGEX`.
2. **Tenant isolation by RLS on storage.** Upload, read and delete are gated on
   `check_user_guild_write_access` for the guild in the first path segment. The
   function reads and deletes under the **caller's** JWT, so RLS — not the
   function — decides which video it can reach.
3. **One reading of the whole video.** The function sends the file to the
   Gemini File API and reads it at `MEDIA_RESOLUTION_HIGH`. The sampling rate is
   derived from the duration Gemini measured, never from a client claim
   (`ocrVideoFps`: a 600-frame budget, between 1 and 8 fps).
4. **Completeness is measured, not assumed.** Leaderboards print a position on
   every row, so a gap in the returned positions is a skipped player; a roster
   without positions falls back to the member counter the game shows ("40/40").
   Missing rows trigger **one** targeted second pass at a higher rate (twice the
   budget, up to 10 fps) that can only **add** players. The response carries
   `coverage: { expected, found, missingPositions }`, and the browser shows it
   under the results: a complete reading says so, an incomplete one names up to
   20 missing positions and asks for a slower scroll or a manual add.
5. **Nothing outlives the scan.** The Gemini file and the staged object are
   deleted whatever happens, including on failure. A recording whose scan never
   completed (the tab was closed mid-upload) is swept by the next video scan of
   that guild once it is more than one hour old (`OCR_VIDEO_STALE_MS`).
6. **Cost is bounded per account.** A video costs a few hundred thousand
   tokens, so video scans are throttled to 20 per 10 minutes per account, and
   the throttle fails closed.
7. **Screenshots are unchanged.** They still go four per call (the Edge
   Function accepts at most five; the margin is deliberate). The image path now
   shares the model loop, task metadata and player normalisation with the video
   path.

**Acceptance criterion: recall against a ground truth, not an impression.**
`tests/fixtures/ocr/leaderboard-2026-10-01.json` transcribes a real
leaderboard by hand (41 rows), and `scripts/ocr-eval.mjs` scores a saved
`ocr-guild-members` response against it: a row counts as read when its pseudo
matches, and as exact when its score matches too.

## Consequences & invariants

- **Never reintroduce client-side frame selection.** What the model sees must
  not depend on a heuristic running in the browser.
- **Never send a video in a request body.** Videos travel through the
  `ocr-videos` bucket; the function receives an object path and nothing else.
- **Storage access stays under the caller's JWT.** Do not read or delete a
  staged video with the service role: that would bypass the tenant check the
  bucket's policies perform.
- **The second pass may only add rows**, and there is at most one.
- **Report coverage; never present an incomplete reading as complete.** The
  `coverage` object and its banner are part of the contract.
- **Delete the staged object and the Gemini file on every path.** The privacy
  policy (`privacy.html` §3.2) and the compliance whitepaper promise that
  recordings are not retained.
- **The video throttle fails closed.**
- **Measure before tuning.** Any change to sampling, budgets or passes is
  judged by `scripts/ocr-eval.mjs` against a ground-truth fixture.
- **Known gaps (2026-10-04).** Phase 2 was merged on the owner's decision
  without an end-to-end production scan, since no video had reached the server
  in the preceding 24 hours: the first real scans are the check, scored with
  `scripts/ocr-eval.mjs`. The ground-truth fixture still awaits the owner's
  spot-check. Phases 3 and 4 of the rework are not scheduled.

## Where it lives

- `supabase/functions/ocr-guild-members/video.ts` — limits, path pattern,
  sampling rate, coverage measurement (pure, imported by vitest).
- `supabase/functions/ocr-guild-members/index.ts` — `handleVideoScan`.
- `src/modules/app/ocr/ocr.controller.ts` — checks, staging and the scan call;
  `ocr.render.ts` — the coverage banner.
- `supabase/migrations/20261001194004_ocr_videos_bucket.sql` — the bucket and
  its policies.
- Tests: `tests/ocr_video_gemini.test.js`, `tests/ocr_video_client.test.js`.
